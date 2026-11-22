import assert from 'node:assert/strict';

export function ordersVerificationTarget(
  environment: NodeJS.ProcessEnv,
  protectedUrls: string[] = [],
) {
  const target = environment.ORDERS_VERIFY_DATABASE_URL;
  assert(
    target,
    'Set ORDERS_VERIFY_DATABASE_URL explicitly; no DATABASE_URL fallback',
  );
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('Invalid disposable database URL');
  }
  assert(
    ['postgres:', 'postgresql:'].includes(url.protocol),
    'PostgreSQL required',
  );
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Loopback database required',
  );
  const name = decodeURIComponent(url.pathname.slice(1));
  // Reuse the existing Stage 2 verifier's disposable database namespace.
  assert(
    /^m7atati_employee_orders_verify_[a-z0-9_]+$/.test(name),
    'Dedicated disposable database name required',
  );
  assert.equal(
    environment.ORDERS_VERIFY_CONFIRM_DATABASE,
    name,
    'Confirm the exact disposable database name',
  );
  assert(
    [...url.searchParams].every(
      ([key, value]) => key === 'schema' && value === 'public',
    ) && url.searchParams.getAll('schema').length <= 1,
    'Only schema=public may be supplied in the URL query',
  );
  for (const protectedUrl of protectedUrls) {
    let protectedName: string;
    try {
      protectedName = decodeURIComponent(
        new URL(protectedUrl).pathname.slice(1),
      );
    } catch {
      throw new Error(
        'Cannot validate configured application database identity',
      );
    }
    assert.notEqual(
      name,
      protectedName,
      'Disposable database must differ from application environment files',
    );
  }
  return { url: target, name };
}

export function requireOrdersVerificationMutations(
  environment: NodeJS.ProcessEnv,
) {
  assert.equal(
    environment.ALLOW_ORDERS_VERIFY_MUTATIONS,
    'yes',
    'Explicit disposable database mutation authorization required',
  );
}
