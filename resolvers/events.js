import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: 'pk = :pk',
      expressionValues: util.dynamodb.toMapValues({ ':pk': 'EVENTS' }),
    },
    consistentRead: true,
    limit: 1000,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  var items = (ctx.result && ctx.result.items) || [];
  return items.map(function (item) { return item.eventId; });
}
