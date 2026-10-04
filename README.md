# 🎬 Subtitle Desk — 小团队视频字幕校对台

供小团队在**本机/内网**协作校对视频字幕的 Web 应用：浏览器时间轴上按毫秒增删改字幕片段、
实时预览、审校、发布不可变版本并导出 SRT。视频文件与 SQLite 数据全部保存在运行服务的本机磁盘。

## 功能一览

- **上传视频**：浏览器读取视频时长（毫秒）并与文件一起上传；服务端流式播放，支持 Range 拖动。
- **毫秒级片段管理**：在时间轴上点击定位，按「起点/终点（ms）」新增、编辑、删除字幕片段。
- **硬性时间规则**（服务端事务内校验，前端输入原样保留、原稿不动）：
  - 起点必须早于终点；
  - 终点不得超过视频时长，起点不得为负；
  - 同视频片段之间**不得时间重叠**（端点相接允许）；
  - 非法操作返回 `422` 与中文原因，编辑弹窗保持你未提交的输入，可修改后重试。
- **乐观锁修订号 `revision`**：
  - 每次修改（含审校、删除）都必须携带「所见修订号」；
  - 修订号过期返回 `409` 冲突与**当前片段内容**，绝不覆盖他人修改；
  - 前端 5 秒自动轮询他人改动（编辑弹窗打开时暂停），收到冲突弹窗可选择放弃或基于最新内容重编。
- **SRT 导入**：为已有视频导入本地 SRT（UTF-8，可含 BOM；序号可不连续；支持多行文本）：
  - 两阶段提交：先**预览**解析出的片段、原文件行号及与当前草稿的时间冲突，确认后才写入；
  - 空文件、格式错误、负时间、起止倒置、越过视频时长、结果片段重叠均指出具体条目（行号），有任何问题都不写入；
  - 写入方式二选一：**追加**（与现有草稿一并校验重叠）或**替换**（仅替换草稿，已发布版本及其 SRT 不变）；
  - 导入片段均为「待审」；预览到确认之间草稿若被他人修改，确认返回 `409` 并要求重新预览；
  - 整批写入在单个事务内完成：要么全部成功，要么完全不变。
- **审校流**：片段有 `待审 / 已审` 状态；**修改已审片段的内容会自动撤销其审校状态**（仅切换审校状态不会）。
- **发布门禁**：至少 1 个片段、全部已审、时间全部合法才能发布。
- **不可变版本**：发布把当前片段整体快照存库；之后的编辑只影响草稿，历史发布版本永不改变。
- **SRT 导出**：下载时可选择「草稿」「最新已发布」或任意历史版本（`?version=draft|published|<版本号>`）。

## 一键启动（Docker Compose，推荐）

需要 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后访问：

- **应用地址**：http://localhost:8080
- **监听端口**：容器内 `8080`，宿主机默认映射 `8080:8080`

停止 / 查看日志：

```bash
docker compose down
docker compose logs -f
```

数据（SQLite 数据库 `app.db` 与上传的视频文件）保存在 Docker 卷 `subtitle-data`
（挂载到容器 `/app/data`），容器重建不丢失。

如不想用命名卷，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
    volumes:
      - ./data:/app/data
```

## 本地直接运行（Node.js ≥ 20）

```bash
npm install
npm start
```

同样访问 http://localhost:8080 。数据默认写入项目下 `./data/`。

运行端到端测试（覆盖校验、冲突、审校撤销、发布门禁、不可变版本与 SRT 导入等 100 个断言）：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用可设 `127.0.0.1` |
| `DB_PATH` | `./data/app.db` | SQLite 数据库文件路径，首次启动自动建表初始化 |
| `UPLOAD_DIR` | `./data/videos` | 上传视频存储目录，自动创建 |
| `MAX_UPLOAD_MB` | `2048` | 单个视频上传大小上限（MB） |
| `MAX_SRT_IMPORT_MB` | `8` | 单个 SRT 导入文件大小上限（MB） |

Compose 中改宿主机端口示例（宿主 9000 → 容器 8080）：

```yaml
    ports:
      - "9000:8080"
```

## 使用流程

1. 打开首页，填写标题并选择视频文件上传（需浏览器可解析的 MP4/WebM 等格式）。
2. 进入工作台：播放视频或点击时间轴定位，用「＋ 新增片段」并可一键取播放位置为起止时间。
3. 也可点「📥 导入 SRT」选择本地字幕文件：先「预览解析」查看条目、原文件行号与冲突，
   选择「追加到现有草稿」或「替换整个草稿」后确认写入（导入片段均为待审）。
4. 在片段表中编辑、删除、定位；逐条「标记已审」。绿色=已审，蓝色=待审。
5. 右侧「发布与下载」面板实时列出阻塞发布的问题；全部满足后点「发布新版本」。
6. 用「下载 SRT ▾」选择草稿或任一已发布版本导出。

## HTTP API 摘要

所有写操作的 JSON 请求体均需携带整数修订号 `revision`（新增片段除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/videos` | multipart 上传：`title`、`duration_ms`、`video` |
| `GET` | `/api/videos` / `/api/videos/:id` | 列表 / 详情（含片段与发布版本） |
| `DELETE` | `/api/videos/:id` | 删除视频及其全部数据 |
| `GET` | `/api/videos/:id/media` | 视频流（支持 `Range`） |
| `POST` | `/api/videos/:id/segments` | 新增片段 `{start_ms,end_ms,text}` |
| `PUT` | `/api/videos/:id/segments/:sid` | 修改 `{start_ms,end_ms,text,revision}` |
| `DELETE` | `/api/videos/:id/segments/:sid` | 删除（JSON 体带 `revision`） |
| `POST` | `/api/videos/:id/segments/:sid/review` | 审校切换 `{reviewed,revision}` |
| `POST` | `/api/videos/:id/srt-import/preview` | 预览 SRT 导入：解析 + 校验 + 与草稿冲突检测，不写库 |
| `POST` | `/api/videos/:id/srt-import/confirm` | 确认导入：携带预览返回的 `draft_fingerprint`，整批原子写入 |
| `GET` | `/api/videos/:id/status` | 发布门禁检查 |
| `POST` | `/api/videos/:id/publish` | 发布不可变版本 |
| `GET` | `/api/videos/:id/publications` | 已发布版本列表 |
| `GET` | `/api/videos/:id/srt?version=` | 导出 SRT：`draft`（默认）/ `published` / `1` 等版本号 |

错误响应统一为 `{ "error": { "code", "message", "current?" } }`：
`422` 为非法修改（含原因），`409` 为修订冲突（`current` 为最新片段）。

### SRT 导入 API

两个端点均接受 JSON（`content` 为 SRT 文本）或 multipart 表单（文件字段 `file`）；
`mode` 取值 `append`（默认，追加到现有草稿）或 `replace`（替换整个草稿）。

**① 预览**（不写库）：返回解析条目（含原文件行号）、问题列表、与草稿的时间冲突及草稿指纹。

```bash
# multipart 上传本地文件
curl -s -F "file=@字幕.srt" -F "mode=append" \
  http://localhost:8080/api/videos/1/srt-import/preview

# 或 JSON 提交文本
curl -s -X POST http://localhost:8080/api/videos/1/srt-import/preview \
  -H 'Content-Type: application/json' \
  -d '{"mode":"append","content":"1\n00:00:01,000 --> 00:00:02,500\n第一句\n"}'
```

响应示例：

```json
{
  "ok": true,
  "mode": "append",
  "cue_count": 2,
  "cues": [{ "seq": 1, "line": 1, "start_ms": 1000, "end_ms": 2500, "text": "第一句" }],
  "errors": [],
  "conflicts": [],
  "draft_segment_count": 3,
  "draft_fingerprint": "4f53cda1…"
}
```

`ok=false` 时看 `errors`（空文件 / 格式错误 / 负时间 / 起止倒置 / 越过视频时长 / 结果片段重叠，
每条都带原文件行号）与 `conflicts`（追加模式下与现有草稿重叠的条目及草稿片段 id）。

**② 确认**（整批原子写入）：把预览返回的 `draft_fingerprint` 原样回传；
预览之后草稿若被他人修改，返回 `409` 并要求重新预览，绝不覆盖他人更改。

```bash
curl -s -X POST http://localhost:8080/api/videos/1/srt-import/confirm \
  -H 'Content-Type: application/json' \
  -d '{"mode":"append","draft_fingerprint":"<预览响应中的值>","content":"1\n00:00:01,000 --> 00:00:02,500\n第一句\n"}'
```

成功返回 `201` 与最新片段列表；内容非法或与草稿冲突返回 `422`（`error.items` 为逐条明细），
此时草稿完全不变。确认接口会重新解析并校验内容，不信任预览结果。

## 数据布局

```
data/
├── app.db            # SQLite：videos / segments / publications
└── videos/           # 上传的原始视频文件（随机化文件名）
```

> 说明：本应用面向可信的本机/小团队内网环境，未内置账号鉴权；如需公网暴露，请自行置于
> 反向代理与访问控制之后，并建议把 `HOST` 绑定到内部地址。
