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
