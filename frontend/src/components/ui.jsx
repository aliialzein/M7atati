import { Link } from "react-router-dom";

export function Title({ title, description, children }) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}
export function Card({ title, description, action, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function Button({ children, to, primary, className = "", ...props }) {
  const style = `button-ui${primary ? " primary" : ""} ${className}`;
  return to ? (
    <Link className={style} to={to} {...props}>
      {children}
    </Link>
  ) : (
    <button type="button" className={style} {...props}>
      {children}
    </button>
  );
}
export function Field({ label, children, help }) {
  return (
    <label className="field-ui">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function Badge({ children, tone = "" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Status({ action }) {
  return (
    <>
      {action.error && (
        <p className="notice error" role="alert">
          {action.error.message}
        </p>
      )}
      {action.success && (
        <p className="notice success" role="status">
          {action.success}
        </p>
      )}
    </>
  );
}
export function Resource({ result, children }) {
  if (result.loading)
    return (
      <p className="notice" role="status">
        Loading…
      </p>
    );
  if (result.error)
    return (
      <div className="notice error" role="alert">
        <p>{result.error.message}</p>
        <Button onClick={result.reload}>Retry</Button>
      </div>
    );
  return result.data ? children(result.data) : null;
}
export function Table({ columns, rows, empty = "No records found." }) {
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={`${columns[0]} table`}
    >
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, cells }) => (
            <tr key={id}>
              {cells.map((cell, index) => (
                <td key={columns[index]}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({ data, page, setPage }) {
  if (!data || (data.totalPages <= 1 && page === 1)) return null;
  return (
    <div className="pagination">
      <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        Previous
      </Button>
      <span>
        Page {page} of {Math.max(1, data.totalPages)}
      </span>
      <Button
        disabled={page >= data.totalPages}
        onClick={() => setPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
export function DateFields({ from, to, onChange }) {
  return (
    <>
      <Field label="From">
        <input
          aria-label="From"
          type="datetime-local"
          value={from}
          onChange={(event) => onChange("from", event.target.value)}
        />
      </Field>
      <Field label="To (exclusive)">
        <input
          aria-label="To (exclusive)"
          type="datetime-local"
          value={to}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </Field>
    </>
  );
}
