/**
 * The ordering rule, and nothing else. Status is deliberately not a parameter.
 *
 * In DynamoDB this is exactly the ConditionExpression:
 *   attribute_not_exists(pk) OR #revision < :incomingRevision
 */
export function decide(storedRevision: number | undefined, incomingRevision: number): 'APPLY' | 'IGNORE' {
  return storedRevision === undefined || incomingRevision > storedRevision ? 'APPLY' : 'IGNORE';
}
