import { LokiQueryModeller } from './LokiQueryModeller';

describe('LokiQueryModeller', () => {
  const modeller = new LokiQueryModeller();

  it('Can query with labels only', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [],
      })
    ).toBe('{app="grafana"}');
  });

  it('Can query with pipeline operation json', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: 'json', params: [] }],
      })
    ).toBe('{app="grafana"} | json');
  });

  it('Can query with pipeline operation logfmt', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: 'logfmt', params: [] }],
      })
    ).toBe('{app="grafana"} | logfmt');
  });

  it('Can query with line filter contains operation', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__line_contains', params: ['error'] }],
      })
    ).toBe('{app="grafana"} |= `error`');
  });

  it('Can query with line filter contains operation with empty params', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__line_contains', params: [''] }],
      })
    ).toBe('{app="grafana"}');
  });

  it('Can query with line filter contains not operation', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__line_contains_not', params: ['error'] }],
      })
    ).toBe('{app="grafana"} != `error`');
  });

  it('Can query with line regex filter', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__line_matches_regex', params: ['error'] }],
      })
    ).toBe('{app="grafana"} |~ `error`');
  });

  it('Can query with line not matching regex', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__line_matches_regex_not', params: ['error'] }],
      })
    ).toBe('{app="grafana"} !~ `error`');
  });

  it('Can query with label filter expression', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__label_filter', params: ['__error__', '=', 'value'] }],
      })
    ).toBe('{app="grafana"} | __error__="value"');
  });

  it('Can query with label filter expression using greater than operator', () => {
    expect(
      modeller.renderQuery({
        labels: [{ label: 'app', op: '=', value: 'grafana' }],
        operations: [{ id: '__label_filter', params: ['count', '>', 'value'] }],
      })
    ).toBe('{app="grafana"} | count > value');
  });

  describe('On add operation handlers', () => {
    it('When adding function without range vector param should automatically add rate', () => {
      const query = {
        labels: [],
        operations: [],
      };

      const def = modeller.getOperationDef('sum');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations[0].id).toBe('rate');
      expect(result.operations[1].id).toBe('sum');
    });

    it('When adding function without range vector param should automatically add rate after existing pipe operation', () => {
      const query = {
        labels: [],
        operations: [{ id: 'json', params: [] }],
      };

      const def = modeller.getOperationDef('sum');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations[0].id).toBe('json');
      expect(result.operations[1].id).toBe('rate');
      expect(result.operations[2].id).toBe('sum');
    });

    it('When adding a pipe operation after a function operation should add pipe operation first', () => {
      const query = {
        labels: [],
        operations: [{ id: 'rate', params: [] }],
      };

      const def = modeller.getOperationDef('json');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations[0].id).toBe('json');
      expect(result.operations[1].id).toBe('rate');
    });

    it('When adding a pipe operation after a line filter operation', () => {
      const query = {
        labels: [],
        operations: [{ id: '__line_contains', params: ['error'] }],
      };

      const def = modeller.getOperationDef('json');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations[0].id).toBe('__line_contains');
      expect(result.operations[1].id).toBe('json');
    });

    it('When adding a line filter operation after format operation', () => {
      const query = {
        labels: [],
        operations: [{ id: 'json', params: [] }],
      };

      const def = modeller.getOperationDef('__line_contains');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations[0].id).toBe('__line_contains');
      expect(result.operations[1].id).toBe('json');
    });

    it('When adding a rate it should not add another rate', () => {
      const query = {
        labels: [],
        operations: [],
      };

      const def = modeller.getOperationDef('rate');
      const result = def.addOperationHandler(def, query, modeller);
      expect(result.operations.length).toBe(1);
    });
  });
});
