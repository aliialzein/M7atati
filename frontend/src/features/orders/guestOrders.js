const guestTokens = new Map();

export function guestOrderToken(id) {
  try {
    return (
      sessionStorage.getItem(`smartstation-order-${id}`) ||
      guestTokens.get(String(id))
    );
  } catch {
    return guestTokens.get(String(id));
  }
}

export function rememberGuestOrder(id, token) {
  guestTokens.set(String(id), token);
  try {
    sessionStorage.setItem(`smartstation-order-${id}`, token);
  } catch {
    /* The active page can still use the in-memory token. */
  }
}
