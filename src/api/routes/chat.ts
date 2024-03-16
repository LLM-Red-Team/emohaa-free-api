import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            // token切分
            const tokens = chat.tokenSplit(request.headers.authorization);
            // 随机挑选一个token
            const token = _.sample(tokens);
            const messages =  request.body.messages;
            if (request.body.stream) {
                const stream = await chat.createCompletionStream(request.body.messages, token, request.body.use_search);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await chat.createCompletion(messages, token, request.body.use_search);
        }

    }

}