import { css } from '@emotion/css';
import { GrafanaTheme2, LoadingState } from '@grafana/data';
import { EditorHeader, FlexItem, InlineSelect, Space, Stack } from '@grafana/experimental';
import { Button, Switch, useStyles2 } from '@grafana/ui';
import { QueryEditorModeToggle } from 'app/plugins/datasource/prometheus/querybuilder/shared/QueryEditorModeToggle';
import { QueryEditorMode } from 'app/plugins/datasource/prometheus/querybuilder/shared/types';
import React, { useCallback, useState } from 'react';
import { LokiQueryEditor } from '../../components/LokiQueryEditor';
import { LokiQueryEditorProps } from '../../components/types';
import { lokiQueryModeller } from '../LokiQueryModeller';
import { LokiVisualQuery } from '../types';
import { LokiQueryBuilder } from './LokiQueryBuilder';

export const LokiQueryEditorSelector = React.memo<LokiQueryEditorProps>((props) => {
  const { query, onChange, onRunQuery, data } = props;
  const styles = useStyles2(getStyles);
  const [visualQuery, setVisualQuery] = useState<LokiVisualQuery>({
    labels: [],
    operations: [],
  });

  const onEditorModeChange = useCallback(
    (newMetricEditorMode: QueryEditorMode) => {
      onChange({ ...query, editorMode: newMetricEditorMode });
    },
    [onChange, query]
  );

  const onChangeViewModel = (updatedQuery: LokiVisualQuery) => {
    setVisualQuery(updatedQuery);

    onChange({
      ...query,
      expr: lokiQueryModeller.renderQuery(updatedQuery),
      editorMode: QueryEditorMode.Builder,
    });
  };

  // If no expr (ie new query) then default to builder
  const editorMode = query.editorMode ?? (query.expr ? QueryEditorMode.Code : QueryEditorMode.Builder);

  return (
    <>
      <EditorHeader>
        <FlexItem grow={1} />
        <Button
          className={styles.runQuery}
          variant="secondary"
          size="sm"
          fill="outline"
          onClick={onRunQuery}
          icon={data?.state === LoadingState.Loading ? 'fa fa-spinner' : undefined}
          disabled={data?.state === LoadingState.Loading}
        >
          Run query {data?.state === LoadingState.Loading ? 'fa fa-spinner' : undefined}
        </Button>
        <Stack gap={1}>
          <label className={styles.switchLabel}>Instant</label>
          <Switch />
        </Stack>
        <Stack gap={1}>
          <label className={styles.switchLabel}>Exemplars</label>
          <Switch />
        </Stack>
        <InlineSelect
          width={14.5}
          value={null}
          placeholder="Query patterns"
          allowCustomValue
          onChange={({ value }) => {}}
          options={[]}
        />
        <QueryEditorModeToggle mode={editorMode} onChange={onEditorModeChange} />
      </EditorHeader>
      <Space v={0.5} />
      {editorMode === QueryEditorMode.Code && <LokiQueryEditor {...props} />}
      {editorMode === QueryEditorMode.Builder && (
        <LokiQueryBuilder
          datasource={props.datasource}
          query={visualQuery}
          onChange={onChangeViewModel}
          onRunQuery={props.onRunQuery}
        />
      )}
    </>
  );
});

LokiQueryEditorSelector.displayName = 'LokiQueryEditorSelector';

const getStyles = (theme: GrafanaTheme2) => {
  return {
    runQuery: css({
      color: theme.colors.text.secondary,
    }),
    switchLabel: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
  };
};
