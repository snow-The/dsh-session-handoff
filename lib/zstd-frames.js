/**
 * zstd-frames.js — Zstandard 拼接帧的【结构化】扫描。
 *
 * 来源（移植，非自创）
 * -------------------
 * 逐字移植自 DSH 官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的
 * `src/zstd.ts` → `scanZstdFrames()`（解压源码位置：
 * `refs/dsh-src-0.1.7-rc.2/packages/session/session-persistence-jsonl/src/zstd.ts:48-104`）。
 * 帧格式依据 Zstandard 官方规范：
 *   https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
 *   （拼接帧 concatenated frames + skippable frames）
 * 本文件是纯 JS（lib/ 无 tsconfig、无构建步骤），TS 类型语法已改为 JSDoc。
 *
 * 为什么移植而不是装依赖
 * ----------------------
 * 该官方包的 `files` 只发 `lib/`（`lib/index.js`、`lib/worker.cjs`、`lib/types/**`），
 * `src/zstd.ts` **不在交付物里**，且该包在本机两个 profile 中都未安装 —— 消费方
 * 拿不到可 import 的 `scanZstdFrames` 入口。装依赖会改动 profile 的依赖树并需要
 * install；移植则零依赖、可立即验证。日后若决定引入官方包，把本文件换成
 * `import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd'`
 * 即可（需先解决上面那个入口问题）。
 *
 * 为什么比原来的"按魔数扫描"好（实测，107.4 MB / 真实会话日志）
 * -------------------------------------------------------------
 *   魔数扫描        21 ms  但只能给出"疑似帧起点"，边界靠解压确认
 *   官方结构扫描    22 ms  给出【逐字节精确】的帧区间，且区间首尾相接、覆盖 100%
 *   逐帧解压      1541 ms  （自建实际解码路径）
 * 结构扫描不解压任何块，只走帧头描述符 + 块头，所以同一个文件上它把
 * "确认边界"的代价从 1541 ms 降到 22 ms。它还有两个魔数扫描没有的能力：
 *   - `tornStart`：EOF 截断的最后一帧起点（撕裂恢复的正解）
 *   - 对结构性损坏**显式 throw**，而不是静默给出错误的边界
 *
 * 与自建行为的关系（重要）
 * ------------------------
 * 官方实现对坏日志 throw；本仓库原实现对坏日志是【继续扫、尽量多读】。
 * 直接替换会让"部分损坏的会话"从"能读到大部分"退化为"完全读不到"。
 * 因此本模块提供两条路：
 *   - scanZstdFramesStrict(buf)  官方语义（损坏即抛）
 *   - frameRanges(buf)           优先结构扫描，失败退回魔数扫描（保住既有韧性）
 * 调用方按需要选。
 */

const ZSTD_MAGIC = 0xfd2fb528;
const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * @typedef {{ start: number, end: number }} ZstdFrameRange  start 含、end 不含
 * @typedef {{ frames: ZstdFrameRange[], tornStart?: number }} ZstdFrameScan
 * @typedef {{ frames: ZstdFrameRange[], tornStart?: number, mode: 'structural'|'magic-fallback', fallbackReason?: string }} FrameRangesResult
 */

/**
 * 定位完整帧，**不解压任何块**。结构性损坏则抛出；EOF 落在帧内则返回其起点。
 *
 * 逐字移植自官方 scanZstdFrames（见文件头出处）。
 * @param {Buffer} buffer 会话产物当前完整存在的字节
 * @param {number} [maxFrames] 可选：只取前 N 个完整帧（元数据读取用）
 * @returns {ZstdFrameScan}
 */
export function scanZstdFramesStrict(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/**
 * 魔数扫描（旧行为）：给出疑似帧起点，不对边界做结构确认。
 * @param {Buffer} buf
 * @returns {number[]}
 */
export function magicOffsets(buf) {
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC_BYTES, i)) !== -1) { offs.push(i); i += 4; }
  return offs;
}

/**
 * 帧区间，**优先结构扫描，失败则退回魔数扫描**。
 *
 * 这是给"既要精确、又不能因为一个坏字节就整份读不到"的调用方用的：
 *   - 结构扫描成功 -> 精确区间（且带 tornStart），与官方语义一致
 *   - 结构扫描抛出 -> 退回魔数区间，并如实标注 mode 与原因，
 *     调用方至少还能拿到"疑似帧起点"（旧行为），而不是完全失败
 * @param {Buffer} buf
 * @returns {FrameRangesResult}
 */
export function frameRanges(buf) {
  try {
    const scan = scanZstdFramesStrict(buf);
    return { ...scan, mode: 'structural' };
  } catch (e) {
    const offs = magicOffsets(buf);
    const frames = offs.map((start, i) => ({
      start,
      end: i + 1 < offs.length ? offs[i + 1] : buf.length,
    }));
    return {
      frames,
      mode: 'magic-fallback',
      fallbackReason: e instanceof Error ? e.message : String(e),
    };
  }
}
