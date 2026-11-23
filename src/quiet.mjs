// Card U9: under the installed command, Node's one notice about node:sqlite is not shown
// above every command (the ledger chose node:sqlite on purpose). The match is exact: that
// message with that type. Every other warning, SQLite-related or not, is still printed.
export const sqliteNotice = 'SQLite is an experimental feature and might change at any time';

/** True only for Node's own node:sqlite notice. */
export function isSqliteNotice(warning, type) {
  const message = typeof warning === 'string' ? warning : warning?.message;
  return type === 'ExperimentalWarning' && message === sqliteNotice;
}

/** Stop that one notice from being emitted by this process. */
export function hideSqliteNotice(proc = process) {
  const emitWarning = proc.emitWarning;
  proc.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (isSqliteNotice(warning, type)) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
}
