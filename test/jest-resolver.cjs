// The sources import './x.js' for files that are './x.ts', which NodeNext requires. Jest has to be
// told to look for the .ts file. A moduleNameMapper would also rewrite imports inside node_modules
// (@opentelemetry/api has its own './diag/types.js'), so this only touches our own files.
module.exports = (request, options) => {
  if (!options.basedir.includes('node_modules') && /^\.{1,2}\//.test(request) && request.endsWith('.js')) {
    try {
      return options.defaultResolver(request.replace(/\.js$/, '.ts'), options);
    } catch {
      // Not one of ours after all. Resolve it normally.
    }
  }
  return options.defaultResolver(request, options);
};
