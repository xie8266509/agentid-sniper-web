// The upstream CLI's keytar service/account are shared by every wallet instance.
// Force its supported encrypted-file fallback without touching global keychain data.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@github/keytar') {
      throw new Error('Project wallet sessions use isolated encrypted file storage');
    }
    return nextResolve(specifier, context);
  },
});
