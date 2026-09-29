import { util } from '@aws-appsync/utils';

// All races that have stored athletes. pk is the fixed word EVENTS, so this
// cannot be confused with an athlete row. consistentRead so a race that was
// just created is visible to the query that follows the POST.

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
