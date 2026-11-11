function isTransientNetworkError(error, visited = new Set()) {
  if (!error || visited.has(error)) {
    return false;
  }
  visited.add(error);

  const code = String(error.code || '').toUpperCase();
  if (
    code === 'EFATAL' ||
    code.startsWith('ECONN') ||
    code.startsWith('EHOST') ||
    code.startsWith('ENET') ||
    code.startsWith('EAI_') ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }

  if (/connection error|fetch failed|network error|socket hang up|timed? ?out|aggregateerror/i.test(error.message || '')) {
    return true;
  }
  if (error.cause && isTransientNetworkError(error.cause, visited)) {
    return true;
  }
  if (Array.isArray(error.errors) && error.errors.some((item) => isTransientNetworkError(item, visited))) {
    return true;
  }
  return false;
}

async function retryTransient(operation, {
  attempts = 3,
  delayMs = 500,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Retry attempts must be a positive integer.');
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientNetworkError(error)) {
        throw error;
      }
      await wait(delayMs * (2 ** (attempt - 1)));
    }
  }
}

module.exports = { isTransientNetworkError, retryTransient };
