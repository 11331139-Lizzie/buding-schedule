#!/usr/bin/env node
/**
 * 布丁课程表 · 课程提醒（邮件 / pushplus 微信）
 *
 * 用法:
 *   node scripts/remind.js remind   # 课前提醒（每15分钟跑一次，命中窗口才发送）
 *   node scripts/remind.js digest   # 每日课表（早上7点跑一次）
 *
 * 环境变量:
 *   MAIL_USER       发件邮箱，如 568330759@qq.com（QQ邮箱需用「授权码」当密码）
 *   MAIL_PASS       邮箱授权码 / 应用专用密码
 *   MAIL_TO         收件邮箱，留空则发给自己（多个用逗号分隔）
 *   MAIL_HOST       默认 smtp.qq.com
 *   MAIL_PORT       默认 465（SSL）
 *   PUSHPLUS_TOKEN  可选，配了会同时推到微信（邮件失败时作为兜底）
 *   INCLUDE_SCHOOL  设为 1 时「上学」也发课前提醒（默认不提醒）
 *   DRY_RUN         设为 1 时只打印不发送（本地调试）
 *   FAKE_NOW        模拟当前时间，如 "2026-10-26 15:35"（本地调试）
 */

const fs = require('fs');
const path = require('path');

const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const MAIL_TO = process.env.MAIL_TO || MAIL_USER;
const MAIL_HOST = process.env.MAIL_HOST || 'smtp.qq.com';
const MAIL_PORT = Number(process.env.MAIL_PORT || 465);
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';

const MODE = (process.argv[2] || 'remind').toLowerCase();
const INCLUDE_SCHOOL = process.env.INCLUDE_SCHOOL === '1';

const TZ = 'Asia/Shanghai';
const WINDOW = [25, 39];        // 提前量落在这个区间才推送（防重复、容忍 Actions 延迟）
const SCHOOL_NAME = '上学';      // 日常上学默认不做课前提醒

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = n => String(n).padStart(2, '0');
const toMin = t => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// ---------- 读取课程数据（与网页共用同一份，避免两处维护） ----------
function readHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

function loadCourseData() {
  const html = readHtml();
  const m = html.match(/const COURSE_DATA = \{[\s\S]*?\n\};/);
  if (!m) throw new Error('无法从 index.html 解析出 COURSE_DATA');
  const src = m[0].replace('const COURSE_DATA = ', '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-eval
  return eval('(' + src + ')');
}

// 课程 / 地点的英文名，同样从 index.html 里取，保持单一数据源
function loadCourseI18n() {
  const html = readHtml();
  const m = html.match(/const COURSE_I18N = \{[\s\S]*?\n\};/);
  if (!m) return {};
  const src = m[0].replace('const COURSE_I18N = ', '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-eval
  return eval('(' + src + ')');
}

const COURSE_I18N = loadCourseI18n();
const enOf = zh => (COURSE_I18N[zh] && COURSE_I18N[zh].en) || '';
// "钢琴课" -> "钢琴课 Piano Class"；没有英文名时只返回中文
const bi = zh => {
  const en = enOf(zh);
  return en && en !== zh ? `${zh} ${en}` : zh;
};

// ---------- 当前北京时间 ----------
function nowShanghai() {
  const fake = process.env.FAKE_NOW;
  if (fake) {
    const mm = fake.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (mm) {
      const [, y, mo, d, h, mi] = mm.map(Number);
      return { year: y, month: mo, day: d, hour: h, minute: mi, minuteOfDay: h * 60 + mi };
    }
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

// ---------- 课程时间（支持 timeOverrides 分阶段改时间） ----------
function resolveTimes(course, dateKey) {
  let start = course.startTime;
  let end = course.endTime;
  if (Array.isArray(course.timeOverrides) && course.timeOverrides.length) {
    const applicable = course.timeOverrides
      .filter(o => !o.from || dateKey >= o.from)
      .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    if (applicable.length) {
      const last = applicable[applicable.length - 1];
      if (last.startTime) start = last.startTime;
      if (last.endTime) end = last.endTime;
    }
  }
  return { start, end };
}

// ---------- 某天有哪些课 ----------
function coursesOn(data, year, month, day) {
  const dateKey = `${year}-${pad2(month)}-${pad2(day)}`;
  const wdIdx = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();

  // 当天请假/取消的课不排（也不提醒）
  const skipped = new Set(
    data.exceptions
      .filter(e => e.date === dateKey && (e.status === 'leave' || e.status === 'cancelled'))
      .map(e => e.courseId)
  );

  const regular = data.courses.filter(c => {
    if (!c.active) return false;
    if (skipped.has(c.id)) return false;
    if (WD.indexOf(c.weekday) !== wdIdx) return false;
    if (c.specificDates && c.specificDates.length) {
      return c.specificDates.includes(dateKey);
    }
    return true;
  });

  const makeup = data.exceptions
    .filter(e => e.date === dateKey && e.status === 'makeup')
    .map(e => {
      const base = data.courses.find(c => c.id === e.courseId);
      if (!base) return null;
      return {
        ...base,
        _makeup: true,
        _overrideStart: e.startTime,
        _overrideEnd: e.endTime,
        _note: e.note,
      };
    })
    .filter(Boolean);

  return regular.concat(makeup).map(c => {
    const t = c._makeup
      ? { start: c._overrideStart, end: c._overrideEnd }
      : resolveTimes(c, dateKey);
    return {
      id: c.id,
      name: c.name,
      location: c.location || '',
      note: c._makeup ? (c._note || '') : (c.note || ''),
      isMakeup: !!c._makeup,
      start: t.start,
      end: t.end,
      startMin: toMin(t.start),
    };
  }).sort((a, b) => a.startMin - b.startMin);
}

// ---------- Markdown 转纯文本（pushplus 的 txt 模板用） ----------
function toPlainText(md) {
  return md
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\-\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 邮件正文（HTML） ----------
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function mailShell(headline, subline, rowsHtml, footer) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:22px 24px;color:#fff;">
      <div style="font-size:19px;font-weight:700;">${headline}</div>
      <div style="font-size:13px;opacity:.9;margin-top:6px;">${subline}</div>
    </div>
    <div style="padding:18px 24px 8px;">
      <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
    </div>
    <div style="padding:12px 24px 20px;color:#9aa0a6;font-size:12px;line-height:1.7;border-top:1px solid #f0f0f0;margin-top:8px;">
      ${footer}
    </div>
  </div>
</body></html>`;
}

function courseRow(c) {
  const tag = c.isMakeup ? '<span style="color:#3498db;font-weight:600;">（补课）</span>' : '';
  const loc = c.location ? ` · ${bi(c.location)}` : '';
  return `<tr>
    <td style="padding:11px 0;border-bottom:1px solid #f2f3f5;white-space:nowrap;vertical-align:top;width:118px;">
      <span style="display:inline-block;background:#eef0ff;color:#4c5bd4;font-weight:700;font-size:13px;padding:4px 9px;border-radius:7px;">${esc(c.start)} - ${esc(c.end)}</span>
    </td>
    <td style="padding:11px 0 11px 12px;border-bottom:1px solid #f2f3f5;font-size:15px;color:#1f2328;line-height:1.5;">
      ${esc(bi(c.name))}${tag}<span style="color:#8a9099;font-size:13px;">${esc(loc)}</span>
    </td>
  </tr>`;
}

// ---------- 发送：邮件优先，pushplus 兜底 ----------
async function send(subject, text, html, md) {
  if (process.env.DRY_RUN === '1') {
    console.log('--- DRY RUN，不实际发送 ---');
    console.log('主题:', subject);
    console.log(text);
    console.log('---------------------------');
    // DUMP_HTML=/path 时把邮件 HTML 存下来预览
    if (process.env.DUMP_HTML) {
      fs.writeFileSync(process.env.DUMP_HTML, html, 'utf8');
      console.log('HTML 已写入:', process.env.DUMP_HTML);
    }
    return;
  }

  if (!MAIL_USER || !MAIL_PASS) {
    throw new Error('缺少 MAIL_USER / MAIL_PASS 环境变量（邮件推送需要）');
  }

  // 延迟 require，保证 DRY_RUN 时无需安装依赖
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: MAIL_PORT === 465,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });

  const info = await transporter.sendMail({
    from: `"布丁课程表" <${MAIL_USER}>`,
    to: MAIL_TO,
    subject,
    text,
    html,
  });
  console.log('✓ 邮件已发送:', info.messageId, '→', MAIL_TO);

  // 配了 pushplus 就顺带推一条微信（可选）
  if (PUSHPLUS_TOKEN) {
    try {
      const channel = process.env.PUSH_CHANNEL || 'wechat';
      const template = process.env.PUSH_TEMPLATE || (channel === 'clawbot' ? 'txt' : 'markdown');
      const res = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: PUSHPLUS_TOKEN,
          title: subject,
          content: template === 'txt' ? toPlainText(md) : md,
          template,
          channel,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.code !== 200) {
        console.warn('⚠ pushplus 推送失败:', res.status, JSON.stringify(body));
      } else {
        console.log('✓ 微信推送已提交');
      }
    } catch (e) {
      console.warn('⚠ pushplus 推送异常:', e.message);
    }
  }
}

// ---------- 课前提醒 ----------
async function runRemind(data, now) {
  const todays = coursesOn(data, now.year, now.month, now.day);
  const hits = [];

  for (const c of todays) {
    if (!INCLUDE_SCHOOL && c.name === SCHOOL_NAME) continue;
    const minsUntil = c.startMin - now.minuteOfDay;
    if (minsUntil >= WINDOW[0] && minsUntil <= WINDOW[1]) {
      hits.push({ c, minsUntil });
    }
  }

  if (!hits.length) {
    console.log('当前无临近课程，跳过');
    return;
  }

  for (const { c, minsUntil } of hits) {
    const tagZh = c.isMakeup ? '（补课）' : '';
    const tagEn = c.isMakeup ? ' (Makeup)' : '';
    const subject = `⏰ ${minsUntil}分钟后 · ${c.name} ${enOf(c.name) || ''} ${c.start}`.replace(/\s+/g, ' ');

    const lines = [
      `⏰ ${c.name}${tagZh} ${enOf(c.name) || ''}${tagEn}`,
      '',
      `时间 / Time：${c.start} - ${c.end}`,
    ];
    if (c.location) lines.push(`地点 / Place：${bi(c.location)}`);
    if (c.note) lines.push(`备注 / Note：${c.note}`);
    lines.push('', `还有 ${minsUntil} 分钟开始 / starts in ${minsUntil} minutes`);

    const html = mailShell(
      `⏰ ${esc(c.name)}${tagZh}`,
      `${esc(enOf(c.name) || '')}${tagEn} · 还有 ${minsUntil} 分钟 / in ${minsUntil} min`,
      courseRow(c),
      c.note ? `备注 / Note：${esc(c.note)}` : '布丁课程表 · 课前 30 分钟提醒',
    );

    await send(subject, lines.join('\n'), html, lines.join('\n'));
  }
}

// ---------- 每日课表 ----------
async function runDigest(data, now) {
  const todays = coursesOn(data, now.year, now.month, now.day);
  const wdIdx = new Date(Date.UTC(now.year, now.month - 1, now.day, 12)).getUTCDay();
  const dateZh = `${now.month}月${now.day}日 ${WD[wdIdx]}`;
  const dateEn = `${WD_EN[wdIdx]}, ${now.year}-${pad2(now.month)}-${pad2(now.day)}`;

  if (!todays.length) {
    console.log('今天没有课程，跳过推送');
    return;
  }

  const subject = `📚 今日有课 · ${dateZh} · ${todays.length}节`;

  const lines = [
    `今日有课 / Today's Classes`,
    `${dateZh}（${dateEn}）· 共 ${todays.length} 节`,
    '',
  ];
  for (const c of todays) {
    const tag = c.isMakeup ? '（补课）' : '';
    const loc = c.location ? ` · ${bi(c.location)}` : '';
    lines.push(`${c.start} - ${c.end}  ${bi(c.name)}${tag}${loc}`);
  }
  lines.push('', '布丁课程表 · 每天早上 7:00 自动发送');

  const html = mailShell(
    `📚 今日有课 · ${todays.length} 节`,
    `${dateZh} · ${dateEn}`,
    todays.map(courseRow).join(''),
    '布丁课程表 · 每天早上 7:00 自动发送<br>Asher Class Schedule · sent daily at 7:00 AM',
  );

  await send(subject, lines.join('\n'), html, lines.join('\n'));
}

// ---------- 入口 ----------
(async () => {
  const now = nowShanghai();
  const stamp = `${now.year}-${pad2(now.month)}-${pad2(now.day)} ${pad2(now.hour)}:${pad2(now.minute)}`;
  console.log(`[${stamp}] 模式=${MODE}`);

  const data = loadCourseData();
  if (MODE === 'digest') await runDigest(data, now);
  else await runRemind(data, now);
})().catch(err => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
