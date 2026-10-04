'use strict';

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// 毫秒 -> SRT 时间戳：HH:MM:SS,mmm
function formatTimestamp(ms) {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

// segments: [{start_ms,end_ms,text}]，按起点排序后生成 SRT
function buildSrt(segments) {
  const ordered = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  return ordered
    .map((s, i) => {
      const text = String(s.text == null ? '' : s.text).replace(/\r\n/g, '\n').trim();
      return `${i + 1}\n${formatTimestamp(s.start_ms)} --> ${formatTimestamp(s.end_ms)}\n${text}\n`;
    })
    .join('\n');
}

/* ---------------- SRT 解析（导入） ---------------- */

// 时间戳行：HH:MM:SS,mmm --> HH:MM:SS,mmm
// 毫秒分隔符兼容逗号与点；小时允许多位；行尾允许附加定位参数（如 X1:.. X2:..）；小时可带负号以便识别负时间
const TS_LINE_RE =
  /^\s*(-?\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(-?\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})(?:\s+.*)?$/;

const MAX_TEXT_LEN = 10000;

function truncate(s, n = 24) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// 毫秒部分按十进制小数解释：',5' -> 500ms，',05' -> 50ms，',005' -> 5ms
function tsToMs(h, m, s, msPart) {
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(msPart.padEnd(3, '0'));
}

// 解析 UTF-8 SRT 文本（可含 BOM；\r\n / \r 换行均可）。返回 { cues, errors }：
//   cues:   [{ seq, line, start_ms, end_ms, text }]，line 为该条目序号行在原文件中的行号（1 起）
//   errors: [{ line, seq, message }]，每个问题都定位到具体条目与原文件行号
// 序号只要求为整数，可不连续、可重复；有任何 error 时调用方不得写入。
function parseSrt(rawContent, opts = {}) {
  const errors = [];
  const cues = [];
  const durationMs = opts.durationMs != null ? opts.durationMs : null;

  let content = String(rawContent == null ? '' : rawContent);
  content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (content.trim() === '') {
    errors.push({ line: null, seq: null, message: '文件为空：未解析到任何字幕条目' });
    return { cues, errors };
  }

  // 按空行分块：每块 = 序号行 + 时间戳行 + 若干文本行；块级错误互不影响，可一次性列出全部问题
  const lines = content.split('\n');
  const blocks = [];
  let block = null;
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      if (block) { blocks.push(block); block = null; }
    } else {
      if (!block) block = { startLine: i + 1, lines: [] };
      block.lines.push(line);
    }
  });
  if (block) blocks.push(block);

  for (const b of blocks) {
    const seqText = b.lines[0].trim();
    if (!/^\d+$/.test(seqText)) {
      errors.push({
        line: b.startLine,
        seq: null,
        message: `第 ${b.startLine} 行：序号行无法识别（「${truncate(seqText)}」），应为整数序号`,
      });
      continue;
    }
    const seq = Number(seqText);
    if (b.lines.length < 2) {
      errors.push({ line: b.startLine, seq, message: `第 ${seq} 条（第 ${b.startLine} 行）：缺少时间戳行` });
      continue;
    }
    const m = TS_LINE_RE.exec(b.lines[1]);
    if (!m) {
      errors.push({
        line: b.startLine + 1,
        seq,
        message: `第 ${seq} 条（第 ${b.startLine + 1} 行）：时间戳格式错误（「${truncate(b.lines[1].trim(), 40)}」），应为「HH:MM:SS,mmm --> HH:MM:SS,mmm」`,
      });
      continue;
    }
    if (m[1].startsWith('-') || m[5].startsWith('-')) {
      errors.push({ line: b.startLine + 1, seq, message: `第 ${seq} 条（第 ${b.startLine + 1} 行）：时间不能为负` });
      continue;
    }
    if (Number(m[2]) >= 60 || Number(m[3]) >= 60 || Number(m[6]) >= 60 || Number(m[7]) >= 60) {
      errors.push({
        line: b.startLine + 1,
        seq,
        message: `第 ${seq} 条（第 ${b.startLine + 1} 行）：时间戳数值非法，分与秒须小于 60`,
      });
      continue;
    }
    const startMs = tsToMs(m[1], m[2], m[3], m[4]);
    const endMs = tsToMs(m[5], m[6], m[7], m[8]);
    if (startMs >= endMs) {
      errors.push({
        line: b.startLine + 1,
        seq,
        message: `第 ${seq} 条（第 ${b.startLine + 1} 行）：起点必须早于终点（${formatTimestamp(startMs)} → ${formatTimestamp(endMs)}）`,
      });
      continue;
    }
    if (durationMs != null && endMs > durationMs) {
      errors.push({
        line: b.startLine + 1,
        seq,
        message: `第 ${seq} 条（第 ${b.startLine + 1} 行）：终点 ${formatTimestamp(endMs)} 超过视频时长 ${formatTimestamp(durationMs)}`,
      });
      continue;
    }
    const text = b.lines.slice(2).join('\n').trim();
    if (!text) {
      errors.push({ line: b.startLine, seq, message: `第 ${seq} 条（第 ${b.startLine} 行）：缺少字幕文本` });
      continue;
    }
    if (text.length > MAX_TEXT_LEN) {
      errors.push({
        line: b.startLine,
        seq,
        message: `第 ${seq} 条（第 ${b.startLine} 行）：字幕文本过长（上限 ${MAX_TEXT_LEN} 字符）`,
      });
      continue;
    }
    cues.push({ seq, line: b.startLine, start_ms: startMs, end_ms: endMs, text });
  }

  // 结果片段之间不得时间重叠（端点相接允许）；按起点排序后逐对检查，指出两条目的序号与行号
  const ordered = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.line - b.line);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start_ms < prev.end_ms) {
      errors.push({
        line: cur.line,
        seq: cur.seq,
        message: `第 ${prev.seq} 条（第 ${prev.line} 行）与第 ${cur.seq} 条（第 ${cur.line} 行）时间重叠（${formatTimestamp(cur.start_ms)} 早于 ${formatTimestamp(prev.end_ms)}）`,
      });
    }
  }

  return { cues, errors };
}

// 追加模式下，导入条目与现有草稿片段之间的时间冲突（端点相接不算）
function findDraftConflicts(cues, draftSegments) {
  const conflicts = [];
  for (const cue of cues) {
    for (const seg of draftSegments) {
      if (cue.start_ms < seg.end_ms && seg.start_ms < cue.end_ms) {
        conflicts.push({
          seq: cue.seq,
          line: cue.line,
          segment_id: seg.id,
          message:
            `第 ${cue.seq} 条（第 ${cue.line} 行）${formatTimestamp(cue.start_ms)} → ${formatTimestamp(cue.end_ms)} ` +
            `与草稿片段 #${seg.id}（${formatTimestamp(seg.start_ms)} → ${formatTimestamp(seg.end_ms)}）时间重叠`,
        });
      }
    }
  }
  return conflicts;
}

module.exports = { formatTimestamp, buildSrt, parseSrt, findDraftConflicts };
