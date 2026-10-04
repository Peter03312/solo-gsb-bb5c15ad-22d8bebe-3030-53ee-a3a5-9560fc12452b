'use strict';

// 端到端业务规则测试：启动真实 HTTP 服务 + 临时 SQLite，不依赖外部框架
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-desk-test-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function req(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; }
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json, ok: res.ok, text: json ? null : null };
}

// multipart 上传构造（避免引入额外依赖）
function multipartVideo(filePath, fields) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n`));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadVideo(title, durationMs, fileSize) {
  const f = path.join(tmpDir, `v-${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(fileSize, 0x78));
  const { body, contentType } = multipartVideo(f, { title, duration_ms: String(durationMs) });
  const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const json = await res.json();
  check('上传返回 201', res.status === 201, JSON.stringify(json));
  return json.video;
}

async function main() {
  console.log('1. 上传与基本校验');
  const v = await uploadVideo('测试视频', 10000, 256);
  eq('时长被记录', v.duration_ms, 10000);

  const badDur = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: -1, text: '' });
  check('负数终点 -> 422', badDur.status === 422);

  {
    const f = path.join(tmpDir, 'bad.mp4');
    fs.writeFileSync(f, Buffer.alloc(16));
    const mp = multipartVideo(f, { title: '坏时长', duration_ms: '-5' });
    const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body });
    const json = await res.json();
    check('非法时长 422', res.status === 422, JSON.stringify(json));
  }

  console.log('2. 片段增删改与时间合法性');
  let r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '第一句' });
  check('新增片段 201', r.status === 201);
  const s1 = r.json.segment;
  eq('新片段默认待审', s1.reviewed, false);
  eq('初始修订号为 1', s1.revision, 1);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 3000, end_ms: 2500, text: '反了' });
  check('起点晚于终点 -> 422', r.status === 422 && /起点必须早于终点/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: 12000, text: '超长' });
  check('终点超过视频时长 -> 422', r.status === 422 && /超过视频时长/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1500, end_ms: 2500, text: '重叠' });
  check('时间重叠 -> 422', r.status === 422 && /重叠/.test(r.json.error.message), r.json && r.json.error.message);

  // 非法修改后原稿仍在
  let list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('非法修改未写入，原稿保留', list.map((x) => [x.start_ms, x.end_ms, x.text]), [[1000, 2000, '第一句']]);

  // 端点相接允许
  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 2000, end_ms: 3000, text: '第二句' });
  check('端点相接不算重叠 201', r.status === 201);
  const s2 = r.json.segment;

  console.log('3. 乐观锁修订号与冲突');
  // A 先改成功，revision 1 -> 2
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(改)', revision: 1 });
  check('携带正确修订号修改成功', r.status === 200);
  eq('修订号递增', r.json.segment.revision, 2);

  // B 拿着过期 revision=1 再改
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '覆盖尝试', revision: 1 });
  check('过期修订号 -> 409 冲突', r.status === 409, r.json && r.json.error.message);
  eq('冲突返回当前内容', r.json && r.json.error.current.text, '第一句(改)');
  eq('冲突返回当前修订号', r.json && r.json.error.current.revision, 2);

  // 过期内容没有覆盖他人修改
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('他人修改未被覆盖', list.find((x) => x.id === s1.id).text, '第一句(改)');

  // 缺少修订号
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '无修订号' });
  check('缺少修订号 -> 422', r.status === 422);

  // 审校操作也要修订号；过期冲突
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 1 });
  check('过期修订号审校 -> 409', r.status === 409);

  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 2 });
  check('正确修订号审校成功', r.status === 200 && r.json.segment.reviewed === true);
  eq('审校后修订号为 3', r.json.segment.revision, 3);

  console.log('4. 修改已审片段撤销审校状态');
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(再改)', revision: 3 });
  check('编辑已审片段成功', r.status === 200);
  eq('审校状态被撤销', r.json.segment.reviewed, false);
  eq('修订号递增到 4', r.json.segment.revision, 4);

  // 删除同样受修订号保护
  r = await req('DELETE', `/videos/${v.id}/segments/${s2.id}`, { revision: 999 });
  check('过期修订号删除 -> 409', r.status === 409);
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  check('冲突删除未生效', list.some((x) => x.id === s2.id));

  console.log('5. 发布门禁与不可变版本');
  // 重新审校 s1（当前 rev 4）
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 4 });
  check('s1 重新审校成功', r.status === 200);

  // s2 未审 -> 不能发布
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('存在未审片段时不能发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));

  // 空视频不能发布
  const empty = await uploadVideo('空视频', 5000, 32);
  r = await req('POST', `/videos/${empty.id}/publish`, {});
  check('无片段不能发布 -> 422', r.status === 422 && /至少需要一个/.test(r.json.error.message));

  // 审校 s2（rev 1）
  r = await req('POST', `/videos/${v.id}/segments/${s2.id}/review`, { reviewed: true, revision: 1 });
  check('s2 审校成功', r.status === 200);

  // 状态接口
  r = await req('GET', `/videos/${v.id}/status`);
  check('全部已审且时间合法时 canPublish', r.json.canPublish === true, JSON.stringify(r.json));

  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('发布成功 201', r.status === 201, JSON.stringify(r.json));
  eq('首个版本号为 1', r.json.publication.version, 1);

  // 草稿 SRT
  let srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=draft`);
  let srt = await srtRes.text();
  check('草稿 SRT 含序号与时间戳', /1\n00:00:01,000 --> 00:00:02,000/.test(srt), JSON.stringify(srt));
  check('SRT 含第二句', /2\n00:00:02,000 --> 00:00:03,000/.test(srt));

  // 已发布 SRT
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=published`);
  srt = await srtRes.text();
  check('已发布 SRT 可下载', srtRes.status === 200 && /第一句\(再改\)/.test(srt));

  // 发布后编辑只影响草稿
  const s1cur = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, {
    start_ms: 1000, end_ms: 2000, text: '发布后的草稿改动', revision: s1cur.revision,
  });
  check('发布后仍可编辑草稿', r.status === 200);
  eq('编辑草稿再次撤销审校', r.json.segment.reviewed, false);

  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=published`)).text();
  check('已发布版本保持不可变', /第一句\(再改\)/.test(srt) && !/草稿改动/.test(srt));
  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映最新编辑', /草稿改动/.test(srt));

  // 指定版本号与不存在版本
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=1`);
  check('按版本号下载 v1', srtRes.status === 200);
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=99`);
  check('不存在版本 -> 404', srtRes.status === 404);
  srtRes = await fetch(`${BASE}/videos/${empty.id}/srt?version=published`);
  check('无发布版本 -> 404', srtRes.status === 404);

  // 审校状态不完整时不能发布 v2
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('新草稿未全部审校时不能发 v2 -> 422', r.status === 422);

  // 重新审校后发布 v2
  const s1now = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: s1now.revision });
  check('s1 再审校', r.status === 200);
  r = await req('POST', `/videos/${v.id}/publish`, {});
  eq('第二个不可变版本号为 2', r.json.publication.version, 2);

  const pubs = (await req('GET', `/videos/${v.id}/publications`)).json.publications;
  eq('版本列表为 [2,1]', pubs.map((p) => p.version), [2, 1]);

  console.log('6. 视频媒体流 Range');
  const rangeRes = await fetch(`http://127.0.0.1:${PORT}/api/videos/${v.id}/media`, { headers: { Range: 'bytes=0-15' } });
  check('Range 请求返回 206', rangeRes.status === 206);
  eq('Content-Range 正确', rangeRes.headers.get('content-range'), 'bytes 0-15/256');

  console.log('7. SRT 导入：预览、校验与原子写入');
  const imp = await uploadVideo('导入测试', 10000, 64);
  r = await req('POST', `/videos/${imp.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '已有片段' });
  check('预置草稿片段 201', r.status === 201);

  // 合法文件：BOM + 序号不连续 + 多行文本 + 与草稿端点相接
  const goodSrt = '\uFEFF' + '1\n00:00:02,000 --> 00:00:03,000\n第二句\n\n7\n00:00:03,500 --> 00:00:04,500\n第三句\n跨两行文本\n';
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: goodSrt, mode: 'append' });
  check('预览 200 且 ok', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  eq('解析出 2 条', r.json.cue_count, 2);
  eq('首条原文件行号', r.json.cues[0].line, 1);
  eq('次条原文件行号', r.json.cues[1].line, 5);
  eq('多行文本保留换行', r.json.cues[1].text, '第三句\n跨两行文本');
  eq('端点相接不算冲突', r.json.conflicts, []);
  const fp1 = r.json.draft_fingerprint;
  check('返回草稿指纹', typeof fp1 === 'string' && fp1.length > 0);

  // 各类非法内容：预览指出具体条目，且均不得写入
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '  \n\n', mode: 'append' });
  check('空文件报错', r.json.ok === false && /为空/.test(r.json.errors[0].message), JSON.stringify(r.json));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '1\n这不是时间戳\n文本\n', mode: 'append' });
  check('时间戳格式错误指出行号', r.json.errors.some((e) => e.line === 2 && /时间戳格式错误/.test(e.message)), JSON.stringify(r.json.errors));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '1\n00:00:02,000 --> 00:00:03,000\n', mode: 'append' });
  check('缺少字幕文本报错', r.json.errors.some((e) => /缺少字幕文本/.test(e.message)));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '1\n-00:00:02,000 --> 00:00:03,000\n负\n', mode: 'append' });
  check('负时间报错', r.json.errors.some((e) => /不能为负/.test(e.message)), JSON.stringify(r.json.errors));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '1\n00:00:03,000 --> 00:00:02,000\n倒置\n', mode: 'append' });
  check('起止倒置报错', r.json.errors.some((e) => /起点必须早于终点/.test(e.message)));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '1\n00:00:09,000 --> 00:00:12,000\n超长\n', mode: 'append' });
  check('越过视频时长报错', r.json.errors.some((e) => /超过视频时长/.test(e.message)));
  const overlapSrt = '1\n00:00:05,000 --> 00:00:07,000\n甲\n\n2\n00:00:06,000 --> 00:00:08,000\n乙\n';
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: overlapSrt, mode: 'append' });
  check('文件内重叠指出两条', r.json.errors.some((e) => /重叠/.test(e.message) && /第 1 条/.test(e.message) && /第 2 条/.test(e.message)), JSON.stringify(r.json.errors));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: '00:00:05,000 --> 00:00:06,000\n无序号\n', mode: 'append' });
  check('缺序号行报错', r.json.errors.some((e) => /序号/.test(e.message)));

  // 与草稿冲突：append 列出冲突，replace 不检查草稿
  const conflictSrt = '1\n00:00:01,500 --> 00:00:02,500\n撞上已有\n';
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: conflictSrt, mode: 'append' });
  check('追加模式列出与草稿的冲突', r.json.ok === false && r.json.conflicts.length === 1 && r.json.conflicts[0].segment_id != null, JSON.stringify(r.json.conflicts));
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: conflictSrt, mode: 'replace' });
  check('替换模式不与草稿冲突', r.json.ok === true && r.json.conflicts.length === 0);

  // 预览阶段不落库
  let impSegs = (await req('GET', `/videos/${imp.id}`)).json.segments;
  eq('预览不写入任何内容', impSegs.map((s) => s.text), ['已有片段']);

  // 确认追加：指纹匹配 -> 整批写入，导入片段待审
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: goodSrt, mode: 'append', draft_fingerprint: fp1 });
  check('确认追加 201', r.status === 201, JSON.stringify(r.json));
  eq('导入 2 条', r.json.imported, 2);
  eq('草稿共 3 条', r.json.segments.length, 3);
  check('导入片段均为待审', r.json.segments.every((s) => !s.reviewed));
  check('导入片段修订号为 1', r.json.segments.filter((s) => s.text.includes('句')).every((s) => s.revision === 1));

  // 预览后草稿被他人修改 -> 确认 409，草稿完全不变
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: goodSrt, mode: 'replace' });
  const fpStale = r.json.draft_fingerprint;
  r = await req('POST', `/videos/${imp.id}/segments`, { start_ms: 8000, end_ms: 9000, text: '他人插入' });
  check('他人修改草稿成功', r.status === 201);
  const beforeIds = (await req('GET', `/videos/${imp.id}`)).json.segments.map((s) => s.id);
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: goodSrt, mode: 'replace', draft_fingerprint: fpStale });
  check('过期指纹 -> 409 要求重新预览', r.status === 409 && /重新预览/.test(r.json.error.message), JSON.stringify(r.json));
  const afterIds = (await req('GET', `/videos/${imp.id}`)).json.segments.map((s) => s.id);
  eq('409 时草稿完全不变', afterIds, beforeIds);

  // 确认时内容非法 -> 422 且原子回滚
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: goodSrt, mode: 'append' });
  const fp2 = r.json.draft_fingerprint;
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: overlapSrt, mode: 'append', draft_fingerprint: fp2 });
  check('确认时内容非法 -> 422 带条目明细', r.status === 422 && Array.isArray(r.json.error.items), JSON.stringify(r.json));
  impSegs = (await req('GET', `/videos/${imp.id}`)).json.segments;
  eq('非法确认未写入任何片段', impSegs.map((s) => s.id), beforeIds);

  // 确认时与草稿冲突 -> 422 不写入
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: conflictSrt, mode: 'append' });
  const fp3 = r.json.draft_fingerprint;
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: conflictSrt, mode: 'append', draft_fingerprint: fp3 });
  check('确认时与草稿冲突 -> 422', r.status === 422 && /冲突/.test(r.json.error.message), JSON.stringify(r.json));

  // 缺指纹 / 缺内容
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: goodSrt, mode: 'append' });
  check('缺指纹 -> 422', r.status === 422);
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { mode: 'append' });
  check('缺内容 -> 422', r.status === 422);

  // 替换导入：仅替换草稿，已发布版本及其 SRT 保持不变
  impSegs = (await req('GET', `/videos/${imp.id}`)).json.segments;
  for (const s of impSegs) {
    r = await req('POST', `/videos/${imp.id}/segments/${s.id}/review`, { reviewed: true, revision: s.revision });
    check(`审校草稿 #${s.id}`, r.status === 200);
  }
  r = await req('POST', `/videos/${imp.id}/publish`, {});
  check('导入前发布 v1', r.status === 201, JSON.stringify(r.json));
  const publishedBefore = await (await fetch(`${BASE}/videos/${imp.id}/srt?version=published`)).text();

  const replaceSrt = '5\n00:00:00,500 --> 00:00:01,500\n替换后的第一句\n\n9\n00:00:02,000 --> 00:00:03,000\n替换后的第二句\n';
  r = await req('POST', `/videos/${imp.id}/srt-import/preview`, { content: replaceSrt, mode: 'replace' });
  check('替换预览 ok', r.json.ok === true, JSON.stringify(r.json));
  r = await req('POST', `/videos/${imp.id}/srt-import/confirm`, { content: replaceSrt, mode: 'replace', draft_fingerprint: r.json.draft_fingerprint });
  check('替换确认 201', r.status === 201, JSON.stringify(r.json));
  eq('替换后草稿仅 2 条', r.json.segments.length, 2);
  eq('替换后文本', r.json.segments.map((s) => s.text), ['替换后的第一句', '替换后的第二句']);
  check('替换后均为待审', r.json.segments.every((s) => !s.reviewed));

  const publishedAfter = await (await fetch(`${BASE}/videos/${imp.id}/srt?version=published`)).text();
  check('已发布版本 SRT 保持不变', publishedAfter === publishedBefore && /已有片段/.test(publishedAfter));
  const draftAfter = await (await fetch(`${BASE}/videos/${imp.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映替换结果', /替换后的第一句/.test(draftAfter) && !/已有片段/.test(draftAfter));
  const impPubs = (await req('GET', `/videos/${imp.id}/publications`)).json.publications;
  eq('发布版本列表不变', impPubs.map((p) => p.version), [1]);

  // multipart 文件上传预览（与 JSON 等效）
  {
    const boundary = '----srtboundary' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nappend\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="subs.srt"\r\nContent-Type: application/x-subrip\r\n\r\n`),
      Buffer.from('1\n00:00:06,000 --> 00:00:07,000\nmultipart 条目\n', 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${BASE}/videos/${imp.id}/srt-import/preview`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    });
    const json = await res.json();
    check('multipart 预览可用', res.status === 200 && json.ok === true && json.cue_count === 1, JSON.stringify(json));
    eq('multipart 返回文件名', json.file_name, 'subs.srt');
  }

  // 非 UTF-8 内容被拒绝
  {
    const boundary = '----srtboundary' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gbk.srt"\r\n\r\n`),
      Buffer.from([0x31, 0x0a, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2c, 0x30, 0x30, 0x30, 0x20, 0x2d, 0x2d, 0x3e, 0x20, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x32, 0x2c, 0x30, 0x30, 0x30, 0x0a, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${BASE}/videos/${imp.id}/srt-import/preview`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    });
    const json = await res.json();
    check('非 UTF-8 文件 -> 422 编码提示', res.status === 422 && /UTF-8/.test(json.error.message), JSON.stringify(json));
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(tmpDir, 'test.db'),
    UPLOAD_DIR: path.join(tmpDir, 'videos'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/videos`);
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器启动超时：\n' + serverOut);
}

waitForServer()
  .then(main)
  .then(() => { server.kill(); fs.rmSync(tmpDir, { recursive: true, force: true }); })
  .catch((e) => {
    console.error('测试运行失败:', e);
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
