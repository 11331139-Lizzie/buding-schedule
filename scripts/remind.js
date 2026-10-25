#!/usr/bin/env node
/**
 * 布丁课程表 · 微信提醒（通过 pushplus 推送到微信「服务通知」）
 *
 * 用法:
 *   node scripts/remind.js remind   # 课前提醒（每15分钟跑一次，命中窗口才推送）
 *   node scripts/remind.js digest   # 每日课表（早上7点跑一次）
 *
 * 环境变量:
 *   PUSHPLUS_TOKEN   pushplus 的用户 token（存在 GitHub Secrets 里）
 *   INCLUDE_SCHOOL   设为 1 时，"上学"也会发课前提醒（默认不提醒）
 *   DRY_RUN          设为 1 时只打印不发送（本地调试）
 *   FAKE_NOW         模拟当前时间，如 "2026-10-26 15:35"（本地调试）
 */

const fs = require('fs');
const path = require('path');

const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const MODE = (process.argv[2] || 'remind').toLowerCase();
const INCLUDE_SCHOOL = process.env.INCLUDE_SCHOOL === '1';

const TZ = 'Asia/Shanghai';
const WINDOW = [25, 39];        // 提前量落在这个区间才推送（防重复、容忍 Actions 延迟）
const SCHOOL_NAME = '上学';      // 日常上学默认不做课前提醒

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = n => String(n).padStart(2, '0');
const toMin = t => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// ---------- 读取课程数据（与网页共用同一份，避免两处维护） ----------
function loadCourseData() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/const COURSE_DATA = \{[\s\S]*?\n\};/);
  if (!m) throw new Error('无法从 index.html 解析出 COURSE_DATA');
  const src = m[0].replace('const COURSE_DATA = ', '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-eval
  return eval('(' + src + ')');
}

// ---------- 当前北京时间 ----------
function nowShanghai() {
  // 测试用：FAKE_NOW="2026-10-26 16:35"
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

// ---------- Markdown 转纯文本（clawbot 的 txt 模板用） ----------
function toPlainText(md) {
  return md
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\-\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 推送（pushplus → 微信服务通知） ----------
async function push(title, content) {
  if (process.env.DRY_RUN === '1') {
    console.log('--- DRY RUN，不实际发送 ---');
    console.log('标题:', title);
    console.log(content);
    console.log('---------------------------');
    return;
  }
  if (!PUSHPLUS_TOKEN) throw new Error('缺少 PUSHPLUS_TOKEN 环境变量');

  // 渠道：wechat = 微信服务号（默认，200条/天，无需手动互动）
  //       clawbot = 微信ClawBot（消息更像私聊，但每10条/每24h需手动发一次消息才能继续）
  const channel = process.env.PUSH_CHANNEL || 'wechat';
  const template = process.env.PUSH_TEMPLATE || (channel === 'clawbot' ? 'txt' : 'markdown');

  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: PUSHPLUS_TOKEN,
      title,
      content: template === 'txt' ? toPlainText(content) : content,
      template,
      channel,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 200) {
    throw new Error(`pushplus 推送失败 HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  console.log('✓ 已提交推送, 流水号:', body.data);
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
    const tag = c.isMakeup ? '（补课）' : '';
    const title = `⏰ ${minsUntil}分钟后 · ${c.name}${tag} ${c.start}`;

    const lines = [
      '## ⏰ 上课提醒',
      '',
      `### ${c.name}${tag}`,
      '',
      `- **时间**：${c.start} - ${c.end}`,
    ];
    if (c.location) lines.push(`- **地点**：${c.location}`);
    if (c.note) lines.push(`- **备注**：${c.note}`);
    lines.push('', `> 还有 **${minsUntil} 分钟** 开始`);

    await push(title, lines.join('\n'));
  }
}

// ---------- 每日课表 ----------
async function runDigest(data, now) {
  const todays = coursesOn(data, now.year, now.month, now.day);
  const wdIdx = new Date(Date.UTC(now.year, now.month - 1, now.day, 12)).getUTCDay();
  const dateText = `${now.month}月${now.day}日 ${WD[wdIdx]}`;

  if (!todays.length) {
    console.log('今天没有课程，跳过推送');
    return;
  }

  const title = `📚 今日课表 · ${dateText}（${todays.length}节）`;

  const lines = [
    '## 📚 今日课程',
    '',
    `**${dateText}** · 共 ${todays.length} 节课`,
    '',
  ];
  for (const c of todays) {
    const tag = c.isMakeup ? '（补课）' : '';
    const loc = c.location ? ` · 📍${c.location}` : '';
    lines.push(`- **${c.start} - ${c.end}**　${c.name}${tag}${loc}`);
  }

  await push(title, lines.join('\n'));
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
