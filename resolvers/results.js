import { util } from '@aws-appsync/utils';

// Athlete rows for one race. begins_with(sk, 'BIB#') skips the STATS item
// that shares the same pk. limit 1000 is one race, not a whole championship.

export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: 'pk = :pk AND begins_with(sk, :prefix)',
      expressionValues: util.dynamodb.toMapValues({
        ':pk': 'EVENT#' + ctx.args.eventId,
        ':prefix': 'BIB#',
      }),
    },
    consistentRead: true,
    limit: 1000,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  var items = (ctx.result && ctx.result.items) || [];
  return items.map(function (item) {
    return {
      bib: item.bib,
      lane: item.lane,
      revision: item.revision,
      status: item.status,
      timeMs: item.timeMs,
    };
  });
}
