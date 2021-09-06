import { mergeMap, throttleTime } from 'rxjs/operators';
import { identity, Unsubscribable, of, Observable, Subject, BehaviorSubject } from 'rxjs';
import {
  DataQuery,
  DataQueryErrorType,
  DataQueryResponse,
  DataSourceApi,
  FieldCache,
  FieldType,
  LoadingState,
  PanelData,
  PanelEvents,
  QueryFixAction,
  toDataFrame,
  toLegacyResponseData,
} from '@grafana/data';

import {
  buildQueryTransaction,
  ensureQueries,
  generateEmptyQuery,
  generateNewKeyAndAddRefIdIfMissing,
  getQueryKeys,
  hasNonEmptyQuery,
  stopQueryState,
  updateHistory,
} from 'app/core/utils/explore';
import { addToRichHistory } from 'app/core/utils/richHistory';
import { ExploreItemState, ExplorePanelData, QueryTransaction, ThunkResult } from 'app/types';
import { ExploreId, QueryOptions } from 'app/types/explore';
import { getTimeZone } from 'app/features/profile/state/selectors';
import { getShiftedTimeRange } from 'app/core/utils/timePicker';
import { notifyApp } from '../../../core/actions';
import { runRequest } from '../../query/state/runRequest';
import { decorateData } from '../utils/decorators';
import { createErrorNotification } from '../../../core/copy/appNotification';
import { richHistoryUpdatedAction, stateSave } from './main';
import { AnyAction, createAction, PayloadAction } from '@reduxjs/toolkit';
import { updateTime } from './time';
import { historyUpdatedAction } from './history';
import { createEmptyQueryResponse, createCacheKey, getResultsFromCache } from './utils';
import { BarAlignment, GraphDrawStyle, StackingMode } from '@grafana/schema';

//
// Actions and Payloads
//

/**
 * Adds a query row after the row with the given index.
 */
export interface AddQueryRowPayload {
  exploreId: ExploreId;
  index: number;
  query: DataQuery;
}
export const addQueryRowAction = createAction<AddQueryRowPayload>('explore/addQueryRow');

/**
 * Remove query row of the given index, as well as associated query results.
 */
export interface RemoveQueryRowPayload {
  exploreId: ExploreId;
  index: number;
}
export const removeQueryRowAction = createAction<RemoveQueryRowPayload>('explore/removeQueryRow');

/**
 * Query change handler for the query row with the given index.
 * If `override` is reset the query modifications and run the queries. Use this to set queries via a link.
 */
export interface ChangeQueryPayload {
  exploreId: ExploreId;
  query: DataQuery;
  index: number;
  override: boolean;
}
export const changeQueryAction = createAction<ChangeQueryPayload>('explore/changeQuery');

/**
 * Clear all queries and results.
 */
export interface ClearQueriesPayload {
  exploreId: ExploreId;
}
export const clearQueriesAction = createAction<ClearQueriesPayload>('explore/clearQueries');

/**
 * Cancel running queries.
 */
export const cancelQueriesAction = createAction<ClearQueriesPayload>('explore/cancelQueries');

export interface QueriesImportedPayload {
  exploreId: ExploreId;
  queries: DataQuery[];
}
export const queriesImportedAction = createAction<QueriesImportedPayload>('explore/queriesImported');

/**
 * Action to modify a query given a datasource-specific modifier action.
 * @param exploreId Explore area
 * @param modification Action object with a type, e.g., ADD_FILTER
 * @param index Optional query row index. If omitted, the modification is applied to all query rows.
 * @param modifier Function that executes the modification, typically `datasourceInstance.modifyQueries`.
 */
export interface ModifyQueriesPayload {
  exploreId: ExploreId;
  modification: QueryFixAction;
  index?: number;
  modifier: (query: DataQuery, modification: QueryFixAction) => DataQuery;
}
export const modifyQueriesAction = createAction<ModifyQueriesPayload>('explore/modifyQueries');

export interface QueryStoreSubscriptionPayload {
  exploreId: ExploreId;
  querySubscription: Unsubscribable;
}

export interface QueryStoreObservableDataPayload {
  exploreId: ExploreId;
  observableData?: Observable<PanelData>;
  panelDataSubject?: Subject<PanelData>;
  lastQueryTransaction?: QueryTransaction;
  isHistogramSupported?: boolean;
}
export const queryStoreSubscriptionAction = createAction<QueryStoreSubscriptionPayload>(
  'explore/queryStoreSubscription'
);
export const queryStoreObservableData = createAction<QueryStoreObservableDataPayload>(
  'explore/queryStoreObservableData'
);

export interface QueryEndedPayload {
  exploreId: ExploreId;
  response: ExplorePanelData;
}
export const queryStreamUpdatedAction = createAction<QueryEndedPayload>('explore/queryStreamUpdated');

/**
 * Reset queries to the given queries. Any modifications will be discarded.
 * Use this action for clicks on query examples. Triggers a query run.
 */
export interface SetQueriesPayload {
  exploreId: ExploreId;
  queries: DataQuery[];
}
export const setQueriesAction = createAction<SetQueriesPayload>('explore/setQueries');

export interface ChangeLoadingStatePayload {
  exploreId: ExploreId;
  loadingState: LoadingState;
}
export const changeLoadingStateAction = createAction<ChangeLoadingStatePayload>('changeLoadingState');

export interface SetPausedStatePayload {
  exploreId: ExploreId;
  isPaused: boolean;
}
export const setPausedStateAction = createAction<SetPausedStatePayload>('explore/setPausedState');

/**
 * Start a scan for more results using the given scanner.
 * @param exploreId Explore area
 * @param scanner Function that a) returns a new time range and b) triggers a query run for the new range
 */
export interface ScanStartPayload {
  exploreId: ExploreId;
}
export const scanStartAction = createAction<ScanStartPayload>('explore/scanStart');

/**
 * Stop any scanning for more results.
 */
export interface ScanStopPayload {
  exploreId: ExploreId;
}
export const scanStopAction = createAction<ScanStopPayload>('explore/scanStop');

/**
 * Adds query results to cache.
 * This is currently used to cache last 5 query results for log queries run from logs navigation (pagination).
 */
export interface AddResultsToCachePayload {
  exploreId: ExploreId;
  cacheKey: string;
  queryResponse: PanelData;
}
export const addResultsToCacheAction = createAction<AddResultsToCachePayload>('explore/addResultsToCache');

export interface LoadHistogramPayload {
  exploreId: ExploreId;
  logsResponse?: DataQueryResponse;
}
export const histogramLoadedAction = createAction<LoadHistogramPayload>('explore/loadHistogram');
export const histogramLoadingStarted = createAction<{ exploreId: ExploreId }>('explore/histogramLoadingStarted');

/**
 *  Clears cache.
 */
export interface ClearCachePayload {
  exploreId: ExploreId;
}
export const clearCacheAction = createAction<ClearCachePayload>('explore/clearCache');
//
// Action creators
//

/**
 * Adds a query row after the row with the given index.
 */
export function addQueryRow(exploreId: ExploreId, index: number): ThunkResult<void> {
  return (dispatch, getState) => {
    const queries = getState().explore[exploreId]!.queries;
    const query = generateEmptyQuery(queries, index);

    dispatch(addQueryRowAction({ exploreId, index, query }));
  };
}

/**
 * Query change handler for the query row with the given index.
 * If `override` is reset the query modifications and run the queries. Use this to set queries via a link.
 */
export function changeQuery(
  exploreId: ExploreId,
  query: DataQuery,
  index: number,
  override = false
): ThunkResult<void> {
  return (dispatch, getState) => {
    // Null query means reset
    if (query === null) {
      const queries = getState().explore[exploreId]!.queries;
      const { refId, key } = queries[index];
      query = generateNewKeyAndAddRefIdIfMissing({ refId, key }, queries, index);
    }

    dispatch(changeQueryAction({ exploreId, query, index, override }));
    if (override) {
      dispatch(runQueries(exploreId));
    }
  };
}

/**
 * Clear all queries and results.
 */
export function clearQueries(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch) => {
    dispatch(scanStopAction({ exploreId }));
    dispatch(clearQueriesAction({ exploreId }));
    dispatch(stateSave());
  };
}

/**
 * Cancel running queries
 */
export function cancelQueries(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch) => {
    dispatch(scanStopAction({ exploreId }));
    dispatch(cancelQueriesAction({ exploreId }));
    dispatch(stateSave());
  };
}

/**
 * Import queries from previous datasource if possible eg Loki and Prometheus have similar query language so the
 * labels part can be reused to get similar data.
 * @param exploreId
 * @param queries
 * @param sourceDataSource
 * @param targetDataSource
 */
export const importQueries = (
  exploreId: ExploreId,
  queries: DataQuery[],
  sourceDataSource: DataSourceApi | undefined | null,
  targetDataSource: DataSourceApi
): ThunkResult<void> => {
  return async (dispatch) => {
    if (!sourceDataSource) {
      // explore not initialized
      dispatch(queriesImportedAction({ exploreId, queries }));
      return;
    }

    let importedQueries = queries;
    // Check if queries can be imported from previously selected datasource
    if (sourceDataSource.meta?.id === targetDataSource.meta?.id) {
      // Keep same queries if same type of datasource, but delete datasource query property to prevent mismatch of new and old data source instance
      importedQueries = queries.map(({ datasource, ...query }) => query);
    } else if (targetDataSource.importQueries) {
      // Datasource-specific importers
      importedQueries = await targetDataSource.importQueries(queries, sourceDataSource);
    } else {
      // Default is blank queries
      importedQueries = ensureQueries();
    }

    const nextQueries = ensureQueries(importedQueries);

    dispatch(queriesImportedAction({ exploreId, queries: nextQueries }));
  };
};

/**
 * Action to modify a query given a datasource-specific modifier action.
 * @param exploreId Explore area
 * @param modification Action object with a type, e.g., ADD_FILTER
 * @param index Optional query row index. If omitted, the modification is applied to all query rows.
 * @param modifier Function that executes the modification, typically `datasourceInstance.modifyQueries`.
 */
export function modifyQueries(
  exploreId: ExploreId,
  modification: QueryFixAction,
  modifier: any,
  index?: number
): ThunkResult<void> {
  return (dispatch) => {
    dispatch(modifyQueriesAction({ exploreId, modification, index, modifier }));
    if (!modification.preventSubmit) {
      dispatch(runQueries(exploreId));
    }
  };
}

/**
 * Main action to run queries and dispatches sub-actions based on which result viewers are active
 */
export const runQueries = (
  exploreId: ExploreId,
  options?: { replaceUrl?: boolean; preserveCache?: boolean; autoLoadHistogram?: boolean }
): ThunkResult<void> => {
  return (dispatch, getState) => {
    options = options || {};
    options.autoLoadHistogram = window.location.href.includes('autoLoadHistogram=on');
    dispatch(updateTime({ exploreId }));

    // We always want to clear cache unless we explicitly pass preserveCache parameter
    const preserveCache = options?.preserveCache === true;
    if (!preserveCache) {
      dispatch(clearCache(exploreId));
    }

    const richHistory = getState().explore.richHistory;
    const exploreItemState = getState().explore[exploreId]!;
    const {
      datasourceInstance,
      queries,
      containerWidth,
      isLive: live,
      range,
      scanning,
      queryResponse,
      querySubscription,
      history,
      refreshInterval,
      absoluteRange,
      cache,
    } = exploreItemState;
    let newQuerySub, observableData;

    const cachedValue = getResultsFromCache(cache, absoluteRange);

    // If we have results saved in cache, we are going to use those results instead of running queries
    if (cachedValue) {
      newQuerySub = of(cachedValue)
        .pipe(mergeMap((data: PanelData) => decorateData(data, queryResponse, absoluteRange, refreshInterval, queries)))
        .subscribe((data) => {
          if (!data.error) {
            dispatch(stateSave());
          }

          dispatch(queryStreamUpdatedAction({ exploreId, response: data }));
        });

      // If we don't have results saved in cache, run new queries
    } else {
      if (!hasNonEmptyQuery(queries)) {
        dispatch(clearQueriesAction({ exploreId }));
        dispatch(stateSave({ replace: options?.replaceUrl })); // Remember to save to state and update location
        return;
      }

      if (!datasourceInstance) {
        return;
      }

      // Some datasource's query builders allow per-query interval limits,
      // but we're using the datasource interval limit for now
      const minInterval = datasourceInstance?.interval;

      stopQueryState(querySubscription);

      const datasourceId = datasourceInstance?.meta.id;

      const queryOptions: QueryOptions = {
        minInterval,
        // maxDataPoints is used in:
        // Loki - used for logs streaming for buffer size, with undefined it falls back to datasource config if it supports that.
        // Elastic - limits the number of datapoints for the counts query and for logs it has hardcoded limit.
        // Influx - used to correctly display logs in graph
        // TODO:unification
        // maxDataPoints: mode === ExploreMode.Logs && datasourceId === 'loki' ? undefined : containerWidth,
        maxDataPoints: containerWidth,
        liveStreaming: live,
      };

      const datasourceName = datasourceInstance.name;
      const timeZone = getTimeZone(getState().user);
      const transaction = buildQueryTransaction(exploreId, queries, queryOptions, range, scanning, timeZone);

      let firstResponse = true;
      dispatch(changeLoadingStateAction({ exploreId, loadingState: LoadingState.Loading }));

      observableData = runRequest(datasourceInstance, transaction.request);

      const subject = new BehaviorSubject<ExplorePanelData | undefined>(undefined);

      newQuerySub = observableData
        .pipe(
          // Simple throttle for live tailing, in case of > 1000 rows per interval we spend about 200ms on processing and
          // rendering. In case this is optimized this can be tweaked, but also it should be only as fast as user
          // actually can see what is happening.
          live ? throttleTime(500) : identity,
          mergeMap((data: PanelData) => decorateData(data, queryResponse, absoluteRange, refreshInterval, queries))
        )
        .subscribe(subject);

      subject.subscribe(
        (data) => {
          if (!data.error && firstResponse) {
            // Side-effect: Saving history in localstorage
            const nextHistory = updateHistory(history, datasourceId, queries);
            const nextRichHistory = addToRichHistory(
              richHistory || [],
              datasourceId,
              datasourceName,
              queries,
              false,
              '',
              ''
            );
            dispatch(historyUpdatedAction({ exploreId, history: nextHistory }));
            dispatch(richHistoryUpdatedAction({ richHistory: nextRichHistory }));

            // We save queries to the URL here so that only successfully run queries change the URL.
            dispatch(stateSave({ replace: options?.replaceUrl }));
          }

          firstResponse = false;

          dispatch(queryStreamUpdatedAction({ exploreId, response: data }));

          // Keep scanning for results if this was the last scanning transaction
          if (getState().explore[exploreId]!.scanning) {
            if (data.state === LoadingState.Done && data.series.length === 0) {
              const range = getShiftedTimeRange(-1, getState().explore[exploreId]!.range);
              dispatch(updateTime({ exploreId, absoluteRange: range }));
              dispatch(runQueries(exploreId));
            } else {
              // We can stop scanning if we have a result
              dispatch(scanStopAction({ exploreId }));
            }
          }
        },
        (error) => {
          dispatch(notifyApp(createErrorNotification('Query processing error', error)));
          dispatch(changeLoadingStateAction({ exploreId, loadingState: LoadingState.Error }));
          console.error(error);
        }
      );

      const isHistogramSupported = datasourceInstance.isHistogramSupported
        ? datasourceInstance.isHistogramSupported(observableData, transaction.request as any)
        : false;
      dispatch(
        queryStoreObservableData({
          exploreId,
          observableData,
          panelDataSubject: subject,
          lastQueryTransaction: transaction,
          isHistogramSupported,
        })
      );
      if (options.autoLoadHistogram && isHistogramSupported) {
        dispatch(loadHistogram(exploreId));
      }
    }

    dispatch(queryStoreSubscriptionAction({ exploreId, querySubscription: newQuerySub }));
  };
};

/**
 * Reset queries to the given queries. Any modifications will be discarded.
 * Use this action for clicks on query examples. Triggers a query run.
 */
export function setQueries(exploreId: ExploreId, rawQueries: DataQuery[]): ThunkResult<void> {
  return (dispatch, getState) => {
    // Inject react keys into query objects
    const queries = getState().explore[exploreId]!.queries;
    const nextQueries = rawQueries.map((query, index) => generateNewKeyAndAddRefIdIfMissing(query, queries, index));
    dispatch(setQueriesAction({ exploreId, queries: nextQueries }));
    dispatch(runQueries(exploreId));
  };
}

/**
 * Start a scan for more results using the given scanner.
 * @param exploreId Explore area
 * @param scanner Function that a) returns a new time range and b) triggers a query run for the new range
 */
export function scanStart(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch, getState) => {
    // Register the scanner
    dispatch(scanStartAction({ exploreId }));
    // Scanning must trigger query run, and return the new range
    const range = getShiftedTimeRange(-1, getState().explore[exploreId]!.range);
    // Set the new range to be displayed
    dispatch(updateTime({ exploreId, absoluteRange: range }));
    dispatch(runQueries(exploreId));
  };
}

export function addResultsToCache(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch, getState) => {
    const queryResponse = getState().explore[exploreId]!.queryResponse;
    const absoluteRange = getState().explore[exploreId]!.absoluteRange;
    const cacheKey = createCacheKey(absoluteRange);

    // Save results to cache only when all results recived and loading is done
    if (queryResponse.state === LoadingState.Done) {
      dispatch(addResultsToCacheAction({ exploreId, cacheKey, queryResponse }));
    }
  };
}

export function loadHistogram(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch, getState) => {
    const state = getState().explore[exploreId]!;
    const observableData = state.observableData;
    const datasource = state.datasourceInstance;
    const transaction = state.lastQueryTransaction;
    const panelDataSubject = state.panelDataSubject;

    if (datasource?.getLogsHistogram) {
      dispatch(histogramLoadingStarted({ exploreId }));
      datasource.getLogsHistogram(observableData, transaction?.request, panelDataSubject).subscribe((result) => {
        console.log('result loaded!');
        dispatch(histogramLoadedAction({ exploreId, logsResponse: result }));
      });
    }
  };
}

export function clearCache(exploreId: ExploreId): ThunkResult<void> {
  return (dispatch) => {
    dispatch(clearCacheAction({ exploreId }));
  };
}

//
// Reducer
//

// Redux Toolkit uses ImmerJs as part of their solution to ensure that state objects are not mutated.
// ImmerJs has an autoFreeze option that freezes objects from change which means this reducer can't be migrated to createSlice
// because the state would become frozen and during run time we would get errors because flot (Graph lib) would try to mutate
// the frozen state.
// https://github.com/reduxjs/redux-toolkit/issues/242
export const queryReducer = (state: ExploreItemState, action: AnyAction): ExploreItemState => {
  if (addQueryRowAction.match(action)) {
    const { queries } = state;
    const { index, query } = action.payload;

    // Add to queries, which will cause a new row to be rendered
    const nextQueries = [...queries.slice(0, index + 1), { ...query }, ...queries.slice(index + 1)];

    return {
      ...state,
      queries: nextQueries,
      logsHighlighterExpressions: undefined,
      queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
    };
  }

  if (changeQueryAction.match(action)) {
    const { queries } = state;
    const { query, index } = action.payload;

    // Override path: queries are completely reset
    const nextQuery: DataQuery = generateNewKeyAndAddRefIdIfMissing(query, queries, index);
    const nextQueries = [...queries];
    nextQueries[index] = nextQuery;

    return {
      ...state,
      queries: nextQueries,
    };
  }

  if (clearQueriesAction.match(action)) {
    const queries = ensureQueries();
    stopQueryState(state.querySubscription);
    return {
      ...state,
      queries: queries.slice(),
      graphResult: null,
      tableResult: null,
      logsResult: null,
      queryKeys: getQueryKeys(queries, state.datasourceInstance),
      queryResponse: createEmptyQueryResponse(),
      loading: false,
    };
  }

  if (cancelQueriesAction.match(action)) {
    stopQueryState(state.querySubscription);

    return {
      ...state,
      loading: false,
    };
  }

  if (modifyQueriesAction.match(action)) {
    const { queries } = state;
    const { modification, index, modifier } = action.payload;
    let nextQueries: DataQuery[];
    if (index === undefined) {
      // Modify all queries
      nextQueries = queries.map((query, i) => {
        const nextQuery = modifier({ ...query }, modification);
        return generateNewKeyAndAddRefIdIfMissing(nextQuery, queries, i);
      });
    } else {
      // Modify query only at index
      nextQueries = queries.map((query, i) => {
        if (i === index) {
          const nextQuery = modifier({ ...query }, modification);
          return generateNewKeyAndAddRefIdIfMissing(nextQuery, queries, i);
        }

        return query;
      });
    }
    return {
      ...state,
      queries: nextQueries,
      queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
    };
  }

  if (removeQueryRowAction.match(action)) {
    const { queries } = state;
    const { index } = action.payload;

    if (queries.length <= 1) {
      return state;
    }

    // removes a query under a given index and reassigns query keys and refIds to keep everything in order
    const queriesAfterRemoval: DataQuery[] = [...queries.slice(0, index), ...queries.slice(index + 1)].map((query) => {
      return { ...query, refId: '' };
    });

    const nextQueries: DataQuery[] = [];

    queriesAfterRemoval.forEach((query, i) => {
      nextQueries.push(generateNewKeyAndAddRefIdIfMissing(query, nextQueries, i));
    });

    return {
      ...state,
      queries: nextQueries,
      logsHighlighterExpressions: undefined,
      queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
    };
  }

  if (setQueriesAction.match(action)) {
    const { queries } = action.payload;
    return {
      ...state,
      queries: queries.slice(),
      queryKeys: getQueryKeys(queries, state.datasourceInstance),
    };
  }

  if (queriesImportedAction.match(action)) {
    const { queries } = action.payload;
    return {
      ...state,
      queries,
      queryKeys: getQueryKeys(queries, state.datasourceInstance),
    };
  }

  if (queryStoreSubscriptionAction.match(action)) {
    const { querySubscription } = action.payload;
    return {
      ...state,
      querySubscription,
    };
  }

  if (queryStoreObservableData.match(action)) {
    const { observableData, lastQueryTransaction, isHistogramSupported, panelDataSubject } = action.payload;
    return {
      ...state,
      observableData,
      lastQueryTransaction,
      isHistogramSupported,
      panelDataSubject,
      logsHistogramIsLoading: false,
      logsHistogram: undefined,
    };
  }

  if (queryStreamUpdatedAction.match(action)) {
    return processQueryResponse(state, action);
  }

  if (queriesImportedAction.match(action)) {
    const { queries } = action.payload;
    return {
      ...state,
      queries,
      queryKeys: getQueryKeys(queries, state.datasourceInstance),
    };
  }

  if (changeLoadingStateAction.match(action)) {
    const { loadingState } = action.payload;
    return {
      ...state,
      queryResponse: {
        ...state.queryResponse,
        state: loadingState,
      },
      loading: loadingState === LoadingState.Loading || loadingState === LoadingState.Streaming,
    };
  }

  if (setPausedStateAction.match(action)) {
    const { isPaused } = action.payload;
    return {
      ...state,
      isPaused: isPaused,
    };
  }

  if (scanStartAction.match(action)) {
    return { ...state, scanning: true };
  }

  if (scanStopAction.match(action)) {
    return {
      ...state,
      scanning: false,
      scanRange: undefined,
    };
  }

  if (addResultsToCacheAction.match(action)) {
    const CACHE_LIMIT = 5;
    const { cache } = state;
    const { queryResponse, cacheKey } = action.payload;

    let newCache = [...cache];
    const isDuplicateKey = newCache.some((c) => c.key === cacheKey);

    if (!isDuplicateKey) {
      const newCacheItem = { key: cacheKey, value: queryResponse };
      newCache = [newCacheItem, ...newCache].slice(0, CACHE_LIMIT);
    }

    return {
      ...state,
      cache: newCache,
    };
  }

  if (histogramLoadedAction.match(action)) {
    const { logsResponse } = action.payload;
    const data = logsResponse?.data.map((series) => {
      const data = toDataFrame(series);
      const fieldCache = new FieldCache(data);

      const valueField = fieldCache.getFirstFieldOfType(FieldType.number)!;

      data.fields[valueField.index].config.min = 0;
      data.fields[valueField.index].config.decimals = 0;

      data.fields[valueField.index].config.custom = {
        drawStyle: GraphDrawStyle.Bars,
        barAlignment: BarAlignment.Center,
        barWidthFactor: 0.9,
        barMaxWidth: 5,
        lineWidth: 0,
        fillOpacity: 100,
        stacking: {
          mode: StackingMode.Normal,
          group: 'A',
        },
      };
      return data;
    });
    console.log(data);

    const result = (state.logsHistogram || []).concat(data || []);

    return {
      ...state,
      logsHistogram: result,
    };
  }

  if (histogramLoadingStarted.match(action)) {
    return {
      ...state,
      logsHistogramIsLoading: true,
    };
  }

  if (clearCacheAction.match(action)) {
    return {
      ...state,
      cache: [],
    };
  }

  return state;
};

export const processQueryResponse = (
  state: ExploreItemState,
  action: PayloadAction<QueryEndedPayload>
): ExploreItemState => {
  const { response } = action.payload;
  const {
    request,
    state: loadingState,
    series,
    error,
    graphResult,
    logsResult,
    tableResult,
    traceFrames,
    nodeGraphFrames,
  } = response;

  if (error) {
    if (error.type === DataQueryErrorType.Timeout) {
      return {
        ...state,
        queryResponse: response,
        loading: loadingState === LoadingState.Loading || loadingState === LoadingState.Streaming,
      };
    } else if (error.type === DataQueryErrorType.Cancelled) {
      return state;
    }

    // Send error to Angular editors
    if (state.datasourceInstance?.components?.QueryCtrl) {
      state.eventBridge.emit(PanelEvents.dataError, error);
    }
  }

  if (!request) {
    return { ...state };
  }

  const latency = request.endTime ? request.endTime - request.startTime : 0;

  // Send legacy data to Angular editors
  if (state.datasourceInstance?.components?.QueryCtrl) {
    const legacy = series.map((v) => toLegacyResponseData(v));
    state.eventBridge.emit(PanelEvents.dataReceived, legacy);
  }

  return {
    ...state,
    latency,
    queryResponse: response,
    graphResult,
    tableResult,
    logsResult,
    loading: loadingState === LoadingState.Loading || loadingState === LoadingState.Streaming,
    showLogs: !!logsResult,
    showMetrics: !!graphResult,
    showTable: !!tableResult,
    showTrace: !!traceFrames.length,
    showNodeGraph: !!nodeGraphFrames.length,
  };
};
