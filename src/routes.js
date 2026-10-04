'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { get } = require('./db');
const { ApiError, isInt, validateTimeline } = require('./validation');
const { buildSrt } = require('./srt');

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
