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

module.exports = { formatTimestamp, buildSrt };
