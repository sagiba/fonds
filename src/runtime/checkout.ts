import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A repository's `.git/HEAD`, or a worktree's `.git` file; not any `.git` name. */
function isCheckout(directory: string): boolean {
  const marker = resolve(directory, ".git");
  try {
    return lstatSync(marker).isFile() || existsSync(resolve(marker, "HEAD"));
  } catch {
    return false;
  }
}

/**
 * The Git checkout containing a module, at any depth, so a bundled entry under
 * `dist/targets/<target>/` protects the same tree as its source. Undefined
 * outside a checkout, such as an installed deployment.
 */
export function enclosingCheckout(moduleUrl: string): string | undefined {
  return nearestAncestor(moduleUrl, isCheckout);
}

function nearestAncestor(
  moduleUrl: string,
  matches: (directory: string) => boolean,
): string | undefined {
  let directory = dirname(realpathSync(fileURLToPath(moduleUrl)));
  for (;;) {
    if (matches(directory)) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Where runtime files must never live: the enclosing checkout or, for an
 * installed deployment, its package (the directory of the nearest
 * package.json), falling back to the module's own directory.
 */
export function protectedDirectory(moduleUrl: string): string {
  return (
    enclosingCheckout(moduleUrl) ??
    nearestAncestor(moduleUrl, (directory) =>
      existsSync(resolve(directory, "package.json")),
    ) ??
    dirname(realpathSync(fileURLToPath(moduleUrl)))
  );
}

/**
 * The absolute path with its existing ancestors' symlinks resolved, so a link
 * cannot direct a runtime file into `root`; undefined when it lies inside.
 */
export function outsideDirectory(
  root: string,
  path: string,
): string | undefined {
  let ancestor = resolve(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor);
  }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, path));
  const fromRoot = relative(root, actual);
  return fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
    ? undefined
    : actual;
}
