import { util } from '@aws-appsync/utils';

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
