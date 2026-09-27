import * as appsync from 'aws-cdk-lib/aws-appsync';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { join } from 'node:path';

const FIELDS = ['events', 'results', 'eventStats', 'updatesRejected'] as const;

/** JS resolvers, read-only. Consistent reads are set in the resolver code. */
export function addResolvers(scope: Construct, api: appsync.GraphqlApi, table: dynamodb.ITable) {
  const source = new appsync.DynamoDbDataSource(scope, 'Table', {
    api,
    table,
    readOnlyAccess: true,
  });
  const dir = join(import.meta.dirname, '../resolvers');
  for (const field of FIELDS) {
    source.createResolver(`${field}Resolver`, {
      typeName: 'Query',
      fieldName: field,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset(join(dir, `${field}.js`)),
    });
  }
}
