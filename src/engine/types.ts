export type RowValue = string | number | boolean | bigint | Date | null | object;
export type RowData = Record<string, RowValue>;
export type Dataset = Map<string, RowData[]>;
