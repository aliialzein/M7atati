BEGIN TRANSACTION READ ONLY;
SELECT employee_id, COUNT(*) AS open_records,
       ARRAY_AGG(id ORDER BY clock_in_at, id) AS record_ids
FROM attendance_records
WHERE clock_out_at IS NULL
GROUP BY employee_id
HAVING COUNT(*) > 1
ORDER BY employee_id;
COMMIT;
