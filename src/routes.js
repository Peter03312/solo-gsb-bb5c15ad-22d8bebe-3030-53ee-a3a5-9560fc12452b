'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { get } = require('./db');
const { ApiError, isInt, validateTimeline } = require('./validation');
const { buildSrt, parseSrt, findDraftConflicts } = require('./srt');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'videos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024 },
});

const router = express.Router();

const now = () => Date.now();

function mapSegment(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    reviewed: row.reviewed === 1,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function loadVideo(videoId) {
  const video = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
  return video;
}

function listSegments(videoId) {
  return get()
    .prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_ms, id')
    .all(videoId)
    .map(mapSegment);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_text', '字幕文本必须为字符串');
  }
  if (value.length > 10000) {
    throw new ApiError(422, 'invalid_text', '字幕文本过长（上限 10000 字符）');
  }
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseRevision(body) {
  const rev = Number(body && body.revision);
  if (!Number.isInteger(rev) || rev < 1) {
    throw new ApiError(422, 'missing_revision', '请携带所见修订号 revision（正整数）');
  }
  return rev;
}

function mapPublication(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    version: row.version,
    segment_count: row.segment_count,
    published_at: row.published_at,
  };
}

/* ---------------- 视频 ---------------- */

router.get('/videos', (req, res) => {
  const rows = get()
    .prepare(
      `SELECT v.*,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id) AS segment_count,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id AND s.reviewed = 1) AS reviewed_count,
              (SELECT MAX(p.version) FROM publications p WHERE p.video_id = v.id) AS latest_version
       FROM videos v ORDER BY v.created_at DESC`
    )
    .all();
  res.json({ videos: rows });
});

router.post('/videos', upload.single('video'), (req, res, next) => {
  let savedPath = null;
  try {
    const title = (req.body.title || '').trim();
    const durationMs = Number(req.body.duration_ms);
    if (!title) throw new ApiError(422, 'invalid_title', '请填写视频标题');
    if (!req.file) throw new ApiError(422, 'missing_file', '请上传视频文件（字段名 video）');
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new ApiError(422, 'invalid_duration', '请由浏览器读取并提交正整数形式的视频时长 duration_ms（毫秒）');
    }

    savedPath = req.file.path;
    const info = get()
      .prepare(
        `INSERT INTO videos (title, storage_name, original_name, mime_type, size_bytes, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, durationMs, now());

    const video = loadVideo(info.lastInsertRowid);
    res.status(201).json({ video, segments: [], publications: [] });
  } catch (err) {
    if (savedPath) fs.promises.unlink(savedPath).catch(() => {});
    next(err);
  }
});

router.get('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    res.json({
      video,
      segments: listSegments(video.id),
      publications: get()
        .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
        .all(video.id)
        .map(mapPublication),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const tx = get().transaction(() => {
      get().prepare('DELETE FROM segments WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM publications WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    });
    tx();
    fs.promises.unlink(path.join(UPLOAD_DIR, video.storage_name)).catch(() => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 视频流（支持 Range 拖动播放）
router.get('/videos/:id(\\d+)/media', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const filePath = path.join(UPLOAD_DIR, video.storage_name);
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'file_missing', '视频文件在服务器上缺失');

    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        res.status(416).set({ 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

/* ---------------- 字幕片段 ---------------- */

// 事务内基于库内最新全量片段做校验；冲突/非法均不改动任何数据
function mutateSegment(videoId, existingId, candidate, expectedRevision) {
  const dbx = get();
  return dbx.transaction(() => {
    const video = dbx.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);

    let existing = null;
    if (existingId != null) {
      existing = dbx.prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(existingId, videoId);
      if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${existingId} 不存在`);
      if (existing.revision !== expectedRevision) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(existing),
        });
      }
    }

    const all = dbx.prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
    const timeline = all.map((row) =>
      row.id === existingId ? { id: row.id, start_ms: candidate.start_ms, end_ms: candidate.end_ms } : row
    );
    if (existingId == null) {
      timeline.push({ id: '(new)', start_ms: candidate.start_ms, end_ms: candidate.end_ms });
    }

    const check = validateTimeline(timeline, video.duration_ms);
    if (!check.ok) {
      throw new ApiError(422, 'invalid_timeline', check.reason, existing ? { current: mapSegment(existing) } : {});
    }

    if (existingId == null) {
      const info = dbx
        .prepare(
          `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, ?)`
        )
        .run(videoId, candidate.start_ms, candidate.end_ms, candidate.text, now());
      return mapSegment(dbx.prepare('SELECT * FROM segments WHERE id = ?').get(info.lastInsertRowid));
    }

    // 内容（时间或文本）被修改 -> 撤销审校状态；仅切换审校不走此接口
    const contentChanged =
      existing.start_ms !== candidate.start_ms ||
      existing.end_ms !== candidate.end_ms ||
      existing.text !== candidate.text;

    const nextReviewed = contentChanged ? 0 : existing.reviewed;
    dbx
      .prepare(
        `UPDATE segments SET start_ms = ?, end_ms = ?, text = ?, reviewed = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(candidate.start_ms, candidate.end_ms, candidate.text, nextReviewed, now(), existingId);

    return mapSegment(dbx.prepare('SELECT * FROM segments WHERE id = ?').get(existingId));
  })();
}

function readCandidate(body, fallback) {
  if (body.start_ms == null || body.end_ms == null) {
    throw new ApiError(422, 'missing_fields', '请同时提供 start_ms 与 end_ms（毫秒）');
  }
  const startMs = Number(body.start_ms);
  const endMs = Number(body.end_ms);
  if (!isInt(startMs) || !isInt(endMs)) {
    throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒');
  }
  const text = normalizeText(body.text != null ? body.text : fallback != null ? fallback.text : '');
  return { start_ms: startMs, end_ms: endMs, text };
}

router.post('/videos/:id(\\d+)/segments', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const candidate = readCandidate(req.body, null);
    const created = mutateSegment(video.id, null, candidate, null);
    res.status(201).json({ segment: created, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.put('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const existing = get()
      .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
      .get(req.params.sid, video.id);
    if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
    const merged = {
      start_ms: req.body.start_ms != null ? Number(req.body.start_ms) : existing.start_ms,
      end_ms: req.body.end_ms != null ? Number(req.body.end_ms) : existing.end_ms,
      text: req.body.text != null ? normalizeText(req.body.text) : existing.text,
    };
    if (!isInt(merged.start_ms) || !isInt(merged.end_ms)) {
      throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒', { current: mapSegment(existing) });
    }
    const updated = mutateSegment(video.id, existing.id, merged, expected);
    res.json({ segment: updated, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

// 审校 / 取消审校；修改已审片段的内容会由 PUT 自动撤销审校
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/review', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const reviewed = req.body.reviewed === true || req.body.reviewed === false ? req.body.reviewed : null;
    if (reviewed == null) throw new ApiError(422, 'invalid_reviewed', '请提交 reviewed: true/false');

    const result = get().transaction(() => {
      const seg = get()
        .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(seg),
        });
      }
      // 审校前再次确认时间合法，避免对非法草稿盖章
      const timeline = get()
        .prepare('SELECT id, start_ms, end_ms FROM segments WHERE video_id = ?')
        .all(video.id);
      const check = validateTimeline(timeline, video.duration_ms);
      if (!check.ok) throw new ApiError(422, 'invalid_timeline', `无法标记审校：${check.reason}`, { current: mapSegment(seg) });

      get()
        .prepare('UPDATE segments SET reviewed = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(reviewed ? 1 : 0, now(), seg.id);
      return mapSegment(get().prepare('SELECT * FROM segments WHERE id = ?').get(seg.id));
    })();

    res.json({ segment: result, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    get().transaction(() => {
      const seg = get()
        .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，请刷新后再删除', {
          current: mapSegment(seg),
        });
      }
      get().prepare('DELETE FROM segments WHERE id = ?').run(seg.id);
    })();
    res.json({ ok: true, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- SRT 导入 ---------------- */

// SRT 文件较小，直接内存解析不落盘；大小上限独立于视频上传
const srtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_SRT_IMPORT_MB || 8) * 1024 * 1024 },
});
function srtUploadMw(req, res, next) {
  srtUpload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      next(new ApiError(422, 'file_too_large', 'SRT 文件超过大小上限（MAX_SRT_IMPORT_MB，默认 8MB）'));
      return;
    }
    next(err);
  });
}

// 草稿内容指纹：预览与确认之间任何草稿变动（增删改、审校切换）都会改变它，用作整批乐观锁
function draftFingerprint(segments) {
  const stable = segments.map((s) => [s.id, s.start_ms, s.end_ms, s.text, s.reviewed ? 1 : 0, s.revision]);
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// 导入请求体：支持 JSON { content, mode, ... } 或 multipart（文件字段 file + 普通字段）
function readImportPayload(req) {
  let content = null;
  let fileName = null;
  if (req.file && req.file.buffer) {
    content = req.file.buffer.toString('utf8');
    fileName = req.file.originalname;
  } else if (req.body && typeof req.body.content === 'string') {
    content = req.body.content;
    fileName = typeof req.body.file_name === 'string' ? req.body.file_name : null;
  }
  if (content == null) {
    throw new ApiError(422, 'missing_content', '请提供 SRT 内容：JSON 字段 content，或 multipart 文件字段 file');
  }
  if (content.includes('\uFFFD')) {
    throw new ApiError(422, 'invalid_encoding', '文件不是有效的 UTF-8 编码，请转换为 UTF-8（可含 BOM）后重试');
  }
  const mode = req.body && req.body.mode === 'replace' ? 'replace' : 'append';
  return { content, mode, fileName };
}

// 预览：解析 + 校验 + 与当前草稿的冲突检测，不写任何数据；返回草稿指纹供确认时回传
router.post('/videos/:id(\\d+)/srt-import/preview', srtUploadMw, (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { content, mode, fileName } = readImportPayload(req);
    const draft = listSegments(video.id);
    const parsed = parseSrt(content, { durationMs: video.duration_ms });
    const conflicts = mode === 'append' ? findDraftConflicts(parsed.cues, draft) : [];
    res.json({
      ok: parsed.errors.length === 0 && conflicts.length === 0,
      mode,
      file_name: fileName,
      duration_ms: video.duration_ms,
      cue_count: parsed.cues.length,
      cues: parsed.cues,
      errors: parsed.errors,
      conflicts,
      draft_segment_count: draft.length,
      draft_fingerprint: draftFingerprint(draft),
    });
  } catch (err) {
    next(err);
  }
});

// 确认：事务内重算草稿指纹（被他人改过则 409 拒绝）、重新解析校验，整批写入或完全不变
router.post('/videos/:id(\\d+)/srt-import/confirm', srtUploadMw, (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { content, mode } = readImportPayload(req);
    const fingerprint = req.body && req.body.draft_fingerprint;
    if (typeof fingerprint !== 'string' || !fingerprint) {
      throw new ApiError(422, 'missing_fingerprint', '请携带预览返回的 draft_fingerprint，以确认草稿未被他人修改');
    }

    const result = get().transaction(() => {
      const draft = listSegments(video.id);
      if (draftFingerprint(draft) !== fingerprint) {
        throw new ApiError(409, 'draft_changed', '草稿在你预览之后已被他人修改，请重新预览后再确认导入（本次未写入任何内容）', {
          draft_segment_count: draft.length,
        });
      }
      const parsed = parseSrt(content, { durationMs: video.duration_ms });
      if (parsed.errors.length > 0) {
        throw new ApiError(422, 'invalid_srt', `SRT 内容存在 ${parsed.errors.length} 处问题，未写入任何片段`, { items: parsed.errors });
      }
      if (mode === 'append') {
        const conflicts = findDraftConflicts(parsed.cues, draft);
        if (conflicts.length > 0) {
          throw new ApiError(422, 'import_conflict', `导入片段与现有草稿存在 ${conflicts.length} 处时间冲突，未写入任何片段`, { items: conflicts });
        }
      } else {
        // 替换模式：仅清空草稿片段，已发布版本及其 SRT 不受影响
        get().prepare('DELETE FROM segments WHERE video_id = ?').run(video.id);
      }
      const insert = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      );
      const ts = now();
      for (const cue of parsed.cues) {
        insert.run(video.id, cue.start_ms, cue.end_ms, cue.text, ts);
      }
      return { imported: parsed.cues.length };
    })();

    res.status(201).json({ ok: true, mode, imported: result.imported, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 发布与导出 ---------------- */

function publicationStatus(videoId, segments) {
  const problems = [];
  if (segments.length === 0) problems.push('至少需要一个字幕片段才能发布');
  if (segments.some((s) => !s.reviewed)) problems.push('仍有片段未通过审校');
  const check = validateTimeline(segments, segmentsVideoDuration(videoId));
  if (!check.ok) problems.push(check.reason);
  return { canPublish: problems.length === 0, problems };
}

function segmentsVideoDuration(videoId) {
  const v = get().prepare('SELECT duration_ms FROM videos WHERE id = ?').get(videoId);
  return v ? v.duration_ms : 0;
}

router.get('/videos/:id(\\d+)/status', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const segments = listSegments(video.id);
    const status = publicationStatus(video.id, segments);
    res.json({ ...status, duration_ms: video.duration_ms });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/publish', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pub = get().transaction(() => {
      const segments = listSegments(video.id);
      const status = publicationStatus(video.id, segments);
      if (!status.canPublish) {
        throw new ApiError(422, 'not_publishable', `当前草稿不能发布：${status.problems.join('；')}`);
      }
      const maxRow = get()
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM publications WHERE video_id = ?')
        .get(video.id);
      const version = maxRow.v + 1;
      const snapshot = JSON.stringify(
        segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }))
      );
      const info = get()
        .prepare(
          `INSERT INTO publications (video_id, version, snapshot, segment_count, published_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(video.id, version, snapshot, segments.length, now());
      return get().prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
    })();
    res.status(201).json({ publication: mapPublication(pub) });
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:id(\\d+)/publications', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pubs = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
      .all(video.id)
      .map(mapPublication);
    res.json({ publications: pubs });
  } catch (err) {
    next(err);
  }
});

function resolveSnapshot(video, versionParam) {
  if (!versionParam || versionParam === 'draft') {
    return { segments: listSegments(video.id), label: 'draft', displayName: '草稿' };
  }
  if (versionParam === 'published') {
    const row = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC LIMIT 1')
      .get(video.id);
    if (!row) throw new ApiError(404, 'no_publication', '该视频尚无已发布版本');
    return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
  }
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(422, 'invalid_version', 'version 取值：draft、published 或正整数版本号');
  }
  const row = get()
    .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
    .get(video.id, version);
  if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
  return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
}

router.get('/videos/:id(\\d+)/srt', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { segments, displayName, label } = resolveSnapshot(video, req.query.version);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(video.title)}-${label}.srt`);
    res.setHeader('X-Subtitle-Desc', encodeURIComponent(displayName));
    res.send(buildSrt(segments));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
