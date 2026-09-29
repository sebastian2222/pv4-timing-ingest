import { util } from '@aws-appsync/utils';

// Pipeline-wide. A corrupt body may not contain an eventId, so this counter
// cannot live on an event row. Missing item means nothing has been rejected yet.

export function request() {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ pk: 'GLOBAL', sk: 'STATS' }),
    consistentRead: true,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  return (ctx.result && ctx.result.updatesRejected) || 0;
}
