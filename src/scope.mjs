import { AsyncLocalStorage } from 'node:async_hooks';

/** Keep provider identity across lazy iteration without mutating model requests. */
export function createProviderScope() {
  const storage = new AsyncLocalStorage();
  return {
    current: () => storage.getStore(),
    wrap(options, next) {
      const scope = { provider: options.provider };
      // Even unselected/nested calls need their own scope, never an inherited selection.
      const iterator = storage.run(scope, () => next()[Symbol.asyncIterator]());
      return {
        [Symbol.asyncIterator]() { return this; },
        next(value) { return storage.run(scope, () => iterator.next(value)); },
        return(value) {
          return storage.run(scope, () => iterator.return?.(value) ?? Promise.resolve({ done: true, value }));
        },
        throw(error) {
          return storage.run(scope, () => iterator.throw?.(error) ?? Promise.reject(error));
        },
      };
    },
  };
}
