import { PassThrough } from "stream";
import path from 'path';
import _ from 'lodash';
import mime from 'mime';
import axios, { AxiosResponse } from 'axios';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

// 模型名称
const MODEL_NAME = 'emohaa';
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Origin': 'https://echo.turing-world.com',
  'Referer': 'https://echo.turing-world.com/',
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

/**
 * 创建会话
 * 
 * 创建临时的会话用于对话补全
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function createConversation(token: string) {
  const result = await axios.get('https://ai-role.cn/echo-prod/generate/id?create=true', {
    headers: {
      Authorization: `Bearer ${token}`,
      ...FAKE_HEADERS,
      ...generateXssParams()
    },
    timeout: 15000,
    validateStatus: () => true
  });
  const convId = checkResult(result);
  return convId;
}

/**
 * 移除会话
 * 
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function removeConversation(convId: string, token: string) {
  const result = await axios.delete(`https://ai-role.cn/echo-prod/conv?cid=${convId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...FAKE_HEADERS,
      ...generateXssParams()
    },
    timeout: 15000,
    validateStatus: () => true
  });
  checkResult(result);
}

/**
 * 同步对话补全
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletion(messages: any[], token: string, useSearch = true, retryCount = 0) {
  return (async () => {
    logger.info(messages);

    // 创建会话
    const convId = await createConversation(token);

    // 请求流
    const prompt = messagesPrepare(messages);
    const xssParams = generateXssParams();
    const result = await axios.get(`https://ai-role.cn/echo-prod/chat?token=${token}&cid=${convId}&prompt=${encodeURIComponent(prompt)}&role=echo&xts=${xssParams['X-Xss-Ts']}&xid=${xssParams['X-Xss-Id']}&xreal=${xssParams['X-Xss-Real']}`, {
      // 120秒超时
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
        ...xssParams
      },
      validateStatus: () => true,
      responseType: 'stream'
    });

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(convId, result.data);
    logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);

    // 异步移除会话
    removeConversation(convId, token)
      .catch(err => console.error(err));

    return answer;
  })()
    .catch(err => {
      if(retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletion(messages, token, useSearch, retryCount + 1);
        })();
      }
      throw err;
    });
}

/**
 * 流式对话补全
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(messages: any[], token: string, useSearch = true, retryCount = 0) {
  return (async () => {
    logger.info(messages);

    // 创建会话
    const convId = await createConversation(token);

    // 请求流
    const prompt = messagesPrepare(messages);
    const xssParams = generateXssParams();
    const result = await axios.get(`https://ai-role.cn/echo-prod/chat?token=${token}&cid=${convId}&prompt=${encodeURIComponent(prompt)}&role=echo&xts=${xssParams['X-Xss-Ts']}&xid=${xssParams['X-Xss-Id']}&xreal=${xssParams['X-Xss-Real']}`, {
      // 120秒超时
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
        ...xssParams
      },
      validateStatus: () => true,
      responseType: 'stream'
    });

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(convId, result.data, () => {
      logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);
      // 流传输结束后异步移除会话
      removeConversation(convId, token)
        .catch(err => console.error(err));
    });
  })()
    .catch(err => {
      if(retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletionStream(messages, token, useSearch, retryCount + 1);
        })();
      }
      throw err;
    });
}

/**
 * 消息预处理
 * 
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(messages: any[]) {
  const content = messages.reduce((content, message) => {
    if (_.isArray(message.content)) {
      return message.content.reduce((_content, v) => {
        if (!_.isObject(v) || v['type'] != 'text')
          return _content;
        return _content + (v['text'] || '');
      }, content);
    }
    return content += `${message.role || 'user'}:${message.content}\n`;
  }, '');

  return content;
}
/**
 * 检查请求结果
 * 
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse) {
  if (!result.data)
    return null;
  if (!_.isObject(result.data))
    return result.data;
  const { status, title, detail } = result.data as any;
  if (!_.isFinite(status))
    return result.data;
  throw new APIException(EX.API_REQUEST_FAILED, `[请求emohaa失败]: [${status}] ${title} ${detail}`);
}

/**
 * 从流接收完整的消息内容
 * 
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 第一条消息初始化
    const data = {
      id: convId,
      model: MODEL_NAME,
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      created: util.unixTimestamp()
    };
    const parser = createParser(event => {
      try {
        if (event.type !== "event") return;
        const text = event.data;
        if (!/^\[DONE\]/.test(text))
          data.choices[0].message.content += text;
      }
      catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", buffer => parser.feed(buffer.toString()));
    stream.once("error", err => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 * 
 * 将流格式转换为gpt兼容流格式
 * 
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(convId: string, stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed && transStream.write(`data: ${JSON.stringify({
    id: convId,
    model: MODEL_NAME,
    object: 'chat.completion.chunk',
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
    ],
    created
  })}\n\n`);
  const parser = createParser(event => {
    try {
      if (event.type !== "event") return;
      const text = event.data;
      if (/^\[DONE\]/.test(text)) {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: MODEL_NAME,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0, delta: {}, finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end('data: [DONE]\n\n');
        endCallback && endCallback();
      }
      else {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: MODEL_NAME,
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
    }
    catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end('\n\n');
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", buffer => parser.feed(buffer.toString()));
  stream.once("error", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  stream.once("close", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  return transStream;
}

/**
 * Token切分
 * 
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace('Bearer ', '').split(',');
}

/**
 * 生成Xss参数
 */
function generateXssParams() {
  const xssId = Math.random().toString();
  const xssTs = `${new Date().getTime()}`;
  const xssReal = util.md5(`${xssTs}-_-${xssId}`);
  return {
    'X-Xss-Id': xssId,
    'X-Xss-Ts': xssTs,
    'X-Xss-Real': xssReal
  };
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  tokenSplit
};
