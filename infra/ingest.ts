import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface IngestProps {
  table: dynamodb.ITable;
  bucket: s3.IBucket;
}

/**
 * POST /timing. The Lambda finishes the write before it responds, so a query
 * that follows the response is not looking at a stale read.
 */
export class Ingest extends Construct {
  readonly fn: lambda.IFunction;
  readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: IngestProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'ProcessorLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'Processor', {
      entry: join(import.meta.dirname, '../src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logGroup: this.logGroup,
      environment: {
        TABLE_NAME: props.table.tableName,
        DEAD_LETTER_BUCKET: props.bucket.bucketName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });
    this.fn = fn;

    props.table.grantReadWriteData(fn);
    // grantReadWriteData does not cover the transaction call the processor uses.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [props.table.tableArn],
    }));
    props.bucket.grantPut(fn);

    const httpApi = new apigwv2.HttpApi(this, 'IngestApi');
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    // Caps a public endpoint without getting in the way of a harness burst.
    stage.defaultRouteSettings = { throttlingRateLimit: 200, throttlingBurstLimit: 400 };

    httpApi.addRoutes({
      path: '/timing',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('Ingest', fn),
    });

    new CfnOutput(scope, 'IngestUrl', { value: `${httpApi.apiEndpoint}/timing` });
  }
}
