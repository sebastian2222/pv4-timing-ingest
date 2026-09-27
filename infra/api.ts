import { Duration, Expiration, CfnOutput } from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import type { Construct } from 'constructs';

/**
 * Just the API shell + key. Data sources and resolvers are added in the main stack.
 *
 * API key expiry: the AppSync default is 7 days. Reviewers will test after you submit,
 * possibly more than a week later — an expired key means every query fails.
 * AppSync allows at most 365 days, computed at synth time; 360 leaves margin so a
 * deploy that happens a while after synth is not rejected.
 */
export function makeApi(scope: Construct, schemaPath: string) {
  const api = new appsync.GraphqlApi(scope, 'Api', {
    name: 'pv4-results',
    definition: appsync.Definition.fromFile(schemaPath),
    authorizationConfig: {
      defaultAuthorization: {
        authorizationType: appsync.AuthorizationType.API_KEY,
        apiKeyConfig: { description: 'PV4 assessment read key', expires: Expiration.after(Duration.days(360)) },
      },
    },
    logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR },
  });
  new CfnOutput(scope, 'GraphqlUrl', { value: api.graphqlUrl });
  new CfnOutput(scope, 'GraphqlApiKey', { value: api.apiKey ?? '' });
  return api;
}
