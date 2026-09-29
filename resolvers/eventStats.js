import { util } from '@aws-appsync/utils';

// Per-race counters. A missing item means the race was never seen: return
// zeros and echo the eventId, not null. 0 is a real value, and `|| 0` keeps it.

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ pk: 'EVENT#' + ctx.args.eventId, sk: 'STATS' }),
    consistentRead: true,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  var item = ctx.result || {};
  return {
    eventId: ctx.args.eventId,
    athletesTracked: item.athletesTracked || 0,
    updatesAccepted: item.updatesAccepted || 0,
    updatesIgnored: item.updatesIgnored || 0,
  };
}
