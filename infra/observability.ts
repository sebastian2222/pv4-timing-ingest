import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { METRIC_NAMESPACE, OUTCOME_METRIC } from '../src/obs';

export interface ObservabilityProps {
  processor: lambda.IFunction;
  logGroup: logs.ILogGroup;
  /** Optional: subscribe an email to alarms (you must click the confirmation email). */
  alarmEmail?: string;
  /** Rejection rate (%) above which to alarm. The brief says ~10% is normal. */
  rejectionRateThresholdPct?: number;
  /** Below this many updates per minute, do not compute a rate (1 bad of 1 = 100%). */
  minUpdatesForRate?: number;
}

/**
 * Section 5.
 *
 * Custom metrics: UpdatesAccepted / UpdatesIgnored / UpdatesRejected in PV4/Timing,
 * emitted by the processor as EMF log lines (see src/obs.ts). Namespace and names are
 * imported from the same module the processor uses, so the alarm cannot drift from
 * what is actually emitted.
 *
 * Alarms:
 *  1. RejectionRateHigh: alarm on the *rate*, not the count. ~10% corruption is a
 *     permanent fact of life per the brief, so a count alarm would either fire all the
 *     time or be set so high it is useless. A jump well above baseline means the venue
 *     feed has broken (firmware change, wrong schema) and someone should look.
 *  2. ProcessorErrors: any unhandled error. Per the brief the processor must never
 *     crash on bad input, so even one is a bug worth waking someone for.
 */
export class Observability extends Construct {
  readonly alarms: cw.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const threshold = props.rejectionRateThresholdPct ?? 25;
    const minN = props.minUpdatesForRate ?? 20;
    const period = Duration.minutes(1);

    const m = (metricName: string, label: string) => new cw.Metric({
      namespace: METRIC_NAMESPACE, metricName, dimensionsMap: { Service: 'pv4-ingest' },
      statistic: cw.Stats.SUM, period, label,
    });
    const accepted = m(OUTCOME_METRIC.ACCEPTED, 'Accepted');
    const ignored = m(OUTCOME_METRIC.IGNORED, 'Ignored');
    const rejected = m(OUTCOME_METRIC.REJECTED, 'Rejected');

    const total = '(FILL(acc,0)+FILL(ign,0)+FILL(rej,0))';
    const rejectionRate = new cw.MathExpression({
      expression: `IF(${total} >= ${minN}, 100*FILL(rej,0)/${total}, 0)`,
      usingMetrics: { acc: accepted, ign: ignored, rej: rejected },
      label: 'Rejection rate %',
      period,
    });

    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: 'PV4 ingest alarms' });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));

    const rateAlarm = new cw.Alarm(this, 'RejectionRateHigh', {
      alarmName: 'pv4-rejection-rate-high',
      alarmDescription: `More than ${threshold}% of timing updates failed validation in 2 of the last 3 minutes (baseline ~10%). The venue feed may have changed format.`,
      metric: rejectionRate,
      threshold,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const errorAlarm = new cw.Alarm(this, 'ProcessorErrors', {
      alarmName: 'pv4-processor-errors',
      alarmDescription: 'The ingest processor threw. Bad input must never crash it, so this is a bug.',
      metric: props.processor.metricErrors({ period, statistic: cw.Stats.SUM }),
      threshold: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // The processor answers 503 instead of throwing, so Lambda's Errors metric
    // stays at zero for those failures. Alarm on the metric the processor emits.
    const processingFailures = new cw.Alarm(this, 'ProcessingFailures', {
      alarmName: 'pv4-processing-failures',
      alarmDescription: 'The processor gave up after retries. State was not updated for that request.',
      metric: m('ProcessingFailures', 'Processing failures'),
      threshold: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // Same revision, two different payloads. The first one is what the scoreboard
    // shows, and only a person can decide which is right.
    const conflictingRevision = new cw.Alarm(this, 'ConflictingRevision', {
      alarmName: 'pv4-conflicting-revision',
      alarmDescription: 'Two different payloads arrived for the same revision. The displayed result may be wrong.',
      metric: m('ConflictingRevision', 'Conflicting revision'),
      threshold: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    for (const a of [rateAlarm, errorAlarm, processingFailures, conflictingRevision]) {
      a.addAlarmAction(new cwActions.SnsAction(topic));
      this.alarms.push(a);
    }

    // Saved Logs Insights queries: CloudWatch → Logs Insights → Saved queries.
    new logs.QueryDefinition(this, 'TraceBib', {
      queryDefinitionName: 'PV4/Trace a bib (edit the bib)',
      logGroups: [props.logGroup],
      queryString: new logs.QueryString({
        fields: ['@timestamp', 'level', 'outcome', 'eventId', 'bib', 'revision', 'status', 'storedRevision', 'reason', 'requestId'],
        filterStatements: ['bib = "AUS-1147"'],
        sort: '@timestamp asc',
        limit: 500,
      }),
    });
    new logs.QueryDefinition(this, 'Rejected', {
      queryDefinitionName: 'PV4/Rejected updates',
      logGroups: [props.logGroup],
      queryString: new logs.QueryString({
        fields: ['@timestamp', 'requestId', 'eventId', 'bib', 'errors.0.field', 'errors.0.reason', 'deadLetterKey'],
        filterStatements: ['outcome = "REJECTED"'],
        sort: '@timestamp desc',
        limit: 200,
      }),
    });

    const dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: 'PV4-Ingest',
      defaultInterval: Duration.hours(3),
    });
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Updates by outcome (per minute)', left: [accepted, ignored, rejected], stacked: true, width: 12 }),
      new cw.GraphWidget({
        title: 'Rejection rate %', left: [rejectionRate], width: 12,
        leftAnnotations: [{ value: threshold, label: 'alarm', color: cw.Color.RED }, { value: 10, label: 'expected ~10%', color: cw.Color.GREY }],
      }),
    );
    dashboard.addWidgets(
      new cw.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 6 }),
      new cw.SingleValueWidget({
        title: 'Totals (dashboard range)', width: 6, setPeriodToTimeRange: true,
        metrics: [accepted, ignored, rejected],
      }),
      new cw.GraphWidget({
        title: 'Processor errors / p95 duration', width: 12,
        left: [props.processor.metricErrors({ period })],
        right: [props.processor.metricDuration({ period, statistic: cw.Stats.p(95) })],
      }),
    );
    dashboard.addWidgets(new cw.LogQueryWidget({
      title: 'Latest rejected updates', width: 24, logGroupNames: [props.logGroup.logGroupName],
      queryLines: [
        'fields @timestamp, requestId, bib, errors.0.field, errors.0.reason',
        'filter outcome = "REJECTED"',
        'sort @timestamp desc',
        'limit 20',
      ],
    }));

    const region = Stack.of(this).region;
    new CfnOutput(scope, 'DashboardUrl', {
      value: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}
