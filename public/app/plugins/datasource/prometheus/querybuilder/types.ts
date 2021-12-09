import { VisualQueryBinary } from './shared/LokiAndPromQueryModellerBase';
import { QueryBuilderLabelFilter, QueryBuilderOperation } from './shared/types';

/**
 * Visual query model
 */
export interface PromVisualQuery {
  metric: string;
  labels: QueryBuilderLabelFilter[];
  operations: QueryBuilderOperation[];
  binaryQueries?: PromVisualQueryBinary[];
}

export type PromVisualQueryBinary = VisualQueryBinary<PromVisualQuery>;

export enum PromVisualQueryOperationCategory {
  Aggregations = 'Aggregations',
  RangeFunctions = 'Range functions',
  Functions = 'Functions',
  Math = 'Math',
}

export interface PromQueryPattern {
  name: string;
  operations: QueryBuilderOperation[];
}

export function getDefaultEmptyQuery() {
  const model: PromVisualQuery = {
    metric: '',
    labels: [],
    operations: [
      { id: 'rate', params: ['auto'] },
      { id: 'sum', params: [] },
    ],
  };

  return model;
}
