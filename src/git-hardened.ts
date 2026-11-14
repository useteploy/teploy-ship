/**
 * The hardened git invocation every credentialed clone, fetch and push runs
 * through (SHIP-02 tier 1, 2026-11-14).
 *
 * THE PROBLEM. A credentialed `git fetch` / `git push` used to run in the
 * workspace the agent had just finished editing, as an ordinary git command.
 * Git reads `.git/config` (and `.git/config.worktree`, anything either
 * includes, and `.git/hooks`) on every command, and a dozen of its keys run a
 * program or move the connection: `url.*.insteadOf` onto an `ext::` transport,
 * `core.fsmonitor`, `core.sshCommand`, `core.hooksPath`, `credential.helper`,
 * `core.askPass`, `core.gitProxy`, `core.alternateRefsCommand`, `gpg.program`
 * with `push.gpgSign`, `http.proxy`, `http.curloptResolve`, a `pre-push` or
 * `reference-transaction` hook. Whatever that program is, it is a child of the
 * credentialed git and inherits the credential. Two `git config` lines written
 * by a prompt-injected agent — or by the repository's own test command, which
 * Ship runs before the push — captured the forge token.
 *
 * THE MECHANISM: an allow-list, not a deny-list. Git has no switch that says
 * "ignore the repository's configuration", and the list of dangerous keys
 * grows with every git release, so the credentialed git is never pointed at
 * the workspace's git directory at all. It runs against a SHADOW git
 * directory the harness creates for this one command:
 *
 *     $shadow/config       written here: bare, object format, remote "origin"
 *                          = the URL the harness holds — nothing else
 *     $shadow/HEAD         an unborn placeholder
 *     $shadow/objects      -> <workspace>/.git/objects      (symlink)
 *     $shadow/refs         -> <workspace>/.git/refs         (symlink)
 *     $shadow/packed-refs  -> <workspace>/.git/packed-refs  (symlink)
 *     $shadow/shallow      -> <workspace>/.git/shallow      (symlink)
 *     $shadow/FETCH_HEAD   -> <workspace>/.git/FETCH_HEAD   (symlink)
 *
 * so the objects, refs and shallow boundary a fetch writes and a push reads
 * are the workspace's own, while its config, its worktree config, its hooks
 * directory, its `info/attributes` and its index are simply not part of the
 * repository git sees. The shadow is bare and git runs with the shadow as its
 * working directory: no work tree, so no `.gitattributes`, no filters, no
 * `.gitmodules`, no fsmonitor. What remains attacker-controlled is DATA —
 * objects, ref values, the shallow file — which is exactly what a forge
 * accepts from an untrusted pusher.
 *
 * On top of that, every hardened invocation:
 *   - starts from a scrubbed environment: every inherited `GIT_*` variable is
 *     unset (GIT_SSH_COMMAND, GIT_PROXY_COMMAND, GIT_ASKPASS, GIT_CONFIG_SYSTEM,
 *     GIT_EXEC_PATH, GIT_TRACE*, GIT_ALTERNATE_OBJECT_DIRECTORIES …), as is
 *     SSH_ASKPASS; HOME and XDG_CONFIG_HOME point into the shadow so there is
 *     no `~/.gitconfig`, `~/.netrc` or XDG git config to read, and
 *     GIT_CONFIG_GLOBAL=/dev/null says so again for git >= 2.32;
 *   - pins, on the command line (which outranks every config file), the keys
 *     that execute or redirect — as a second lock, and against a system
 *     gitconfig that sets one;
 *   - allows only the transport of the URL it was given (`protocol.allow=never`
 *     plus http/https, or file for a local path);
 *   - refuses to run if git, under this configuration, would rewrite the URL
 *     (`ls-remote --get-url` and `remote get-url --push` must both print the
 *     harness's URL back);
 *   - never recurses into submodules, never runs gc, never prompts.
 *
 * THE CREDENTIAL travels as before — an origin-scoped `http.extraHeader` in
 * GIT_CONFIG_* (git.ts gitCredential) — but the script moves it out of the
 * environment into an unexported shell variable as its first act, and exports
 * it again only inside the subshell that `exec`s the hardened git. No other
 * process the script starts has it in its environment.
 *
 * A credentialed script contains hardened git and shell plumbing ONLY. An
 * ordinary `git checkout` in the same shell would read the workspace's config
 * and could run the agent's program as a child of a shell whose initial
 * environment held the credential; the call sites in git.ts run those as
 * separate, credential-free execs.
 *
 * System configuration (`/etc/gitconfig`) is deliberately still read. It
 * belongs to whoever built the image, exactly as the git binary does; it is
 * where a proxy or a private CA bundle legitimately lives; and anyone who can
 * write it can replace `git` itself.
 *
 * WHAT THIS DOES NOT CLOSE (tier 2; AUDIT_OPEN.md, "SHIP-02"): the agent and
 * this git share a container and a uid. A process the agent left running can
 * read `/proc/<pid>/environ` of the credentialed git, or race the shadow
 * directory; and in the sandbox the run user has passwordless sudo, so it can
 * replace the `git` on PATH. Only publishing from a repository the harness
 * owns, outside the agent's container, closes those.
 */

/** Exit status of a hardened script that refused to run git at all. */
export const HARDENED_REFUSAL_EXIT = 97;

/** Single-quote a value for `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Config pinned on the command line of every hardened git. The shadow's own
 * config already holds none of these; this is the second lock, and the only
 * one against a key set in the system gitconfig.
 */
export const HARDENED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.sshCommand", "false"],
  ["core.gitProxy", ""],
  ["core.askPass", ""],
  // Default: `git for-each-ref` run INSIDE each alternate, under that
  // repository's own config. `true` advertises no alternate tips instead.
  ["core.alternateRefsCommand", "true"],
  ["credential.helper", ""],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
  ["submodule.recurse", "false"],
  ["push.gpgSign", "false"],
  ["protocol.allow", "never"],
];

function protocolsFor(url: string): string[] {
  if (/^https?:\/\//i.test(url)) return ["http", "https"];
  if (url.startsWith("/")) return ["file"];
  throw new Error(`refusing a credentialed git step for a remote that is neither http(s) nor a local path: ${url.replace(/\/\/[^@/\s]+@/, "//***@")}`);
}

/**
 * The shell that runs `body` with the hardened git available as functions:
 *
 *   ship_git <args>        hardened git on the shadow of this workspace's
 *                          repository, WITH the credential (fetch, push,
 *                          ls-remote). The remote is "$SHIP_GIT_URL", also
 *                          configured as `origin`.
 *   ship_git_plain <args>  the same git on the same shadow, WITHOUT the
 *                          credential (rev-parse, symbolic-ref).
 *   ship_git_clone <args>  hardened `git <args>` in the workspace itself,
 *                          with the credential — for `clone` into the empty
 *                          workspace, where there is no repository to shadow
 *                          and no local config to distrust yet.
 *   ship_git_here <args>   as ship_git_clone, without the credential.
 *
 * `body` must not call plain `git`; see the module comment. `url` is the
 * remote the harness holds for this step and is the ONLY remote the hardened
 * git can be pointed at by name.
 */
export function hardenedGitScript(url: string, body: string): string {
  if (url === "" || /[\u0000- \u007f]/.test(url)) throw new Error("refusing a credentialed git step for a malformed remote URL");
  const flags = [
    ...HARDENED_GIT_CONFIG,
    ...protocolsFor(url).map((p) => [`protocol.${p}.allow`, "always"] as const),
  ]
    .map(([key, value]) => `-c ${shellQuote(`${key}=${value}`)}`)
    .join(" ");
  const refuse = (why: string): string => `{ echo ${shellQuote(`ship: ${why}`)} >&2; exit ${HARDENED_REFUSAL_EXIT}; }`;
  return [
    // The credential leaves the environment before anything else runs.
    "_sg_n=${GIT_CONFIG_COUNT-}; _sg_k=${GIT_CONFIG_KEY_0-}; _sg_v=${GIT_CONFIG_VALUE_0-}",
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 SSH_ASKPASS",
    // Every other inherited GIT_* goes too: none of them is ours.
    `for _sg_e in $(env | sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$_sg_e"; done`,
    `SHIP_GIT_URL=${shellQuote(url)}`,
    `_sg_ws=$(pwd -P) || ${refuse("cannot resolve the workspace directory")}`,
    `_sg_dir=$(mktemp -d 2>/dev/null) || _sg_dir=$(mktemp -d "$_sg_ws/.git/ship-git.XXXXXX" 2>/dev/null) || ${refuse("cannot create a private directory for the credentialed git step")}`,
    `trap 'rm -rf "$_sg_dir"' EXIT`,
    `mkdir -p "$_sg_dir/home" "$_sg_dir/repo" || ${refuse("cannot prepare the private directory for the credentialed git step")}`,
    // $1: 1 = attach the credential. $2: directory to run in. $3: GIT_DIR, or
    // empty to let git find (or create) the repository there. Rest: git
    // arguments. Everything is exported inside the subshell that execs git,
    // so nothing here outlives the one process it is for.
    "_sg_run() { ( _sg_c=$1; _sg_g=$3; cd \"$2\" || exit " + String(HARDENED_REFUSAL_EXIT) + "; shift 3; " +
      'export HOME="$_sg_dir/home" XDG_CONFIG_HOME="$_sg_dir/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=; ' +
      'if [ -n "$_sg_g" ]; then export GIT_DIR="$_sg_g"; fi; ' +
      'if [ "$_sg_c" = 1 ] && [ -n "$_sg_n" ]; then export GIT_CONFIG_COUNT="$_sg_n" GIT_CONFIG_KEY_0="$_sg_k" GIT_CONFIG_VALUE_0="$_sg_v"; fi; ' +
      `exec git ${flags} "$@" ); }`,
    // The shadow git directory, built once per script on first use.
    "_sg_shadow() { " +
      '[ -f "$_sg_dir/repo/config" ] && return 0; ' +
      `[ -d "$_sg_ws/.git" ] && [ ! -L "$_sg_ws/.git" ] || ${refuse("the workspace has no .git directory; refusing the credentialed git step")}; ` +
      // The object and ref formats are read as TEXT. Running the workspace's
      // own git to ask would be running it under the workspace's config.
      "_sg_ext=; " +
      `if grep -qiE '^[[:space:]]*objectformat[[:space:]]*=[[:space:]]*sha256[[:space:]]*$' "$_sg_ws/.git/config" 2>/dev/null; then _sg_ext="$_sg_ext\\tobjectformat = sha256\\n"; fi; ` +
      `if grep -qiE '^[[:space:]]*refstorage[[:space:]]*=[[:space:]]*reftable[[:space:]]*$' "$_sg_ws/.git/config" 2>/dev/null; then _sg_ext="$_sg_ext\\trefstorage = reftable\\n"; ln -s "$_sg_ws/.git/reftable" "$_sg_dir/repo/reftable" || exit ${HARDENED_REFUSAL_EXIT}; fi; ` +
      `for _sg_f in objects refs packed-refs shallow FETCH_HEAD; do ln -s "$_sg_ws/.git/$_sg_f" "$_sg_dir/repo/$_sg_f" || exit ${HARDENED_REFUSAL_EXIT}; done; ` +
      `printf 'ref: refs/heads/.ship-shadow\\n' > "$_sg_dir/repo/HEAD" || exit ${HARDENED_REFUSAL_EXIT}; ` +
      'if [ -n "$_sg_ext" ]; then printf "[core]\\n\\trepositoryformatversion = 1\\n\\tbare = true\\n[extensions]\\n$_sg_ext" > "$_sg_dir/repo/config"; ' +
      'else printf "[core]\\n\\trepositoryformatversion = 0\\n\\tbare = true\\n" > "$_sg_dir/repo/config"; fi; ' +
      `_sg_run 0 "$_sg_dir/repo" "$_sg_dir/repo" config -f "$_sg_dir/repo/config" remote.origin.url "$SHIP_GIT_URL" || ${refuse("cannot write the shadow git configuration")}; ` +
      // The push/fetch target must be the URL the harness holds, after git has
      // applied every rewrite its configuration knows.
      '[ "$(_sg_run 0 "$_sg_dir/repo" "$_sg_dir/repo" ls-remote --get-url origin 2>/dev/null)" = "$SHIP_GIT_URL" ] && ' +
      '[ "$(_sg_run 0 "$_sg_dir/repo" "$_sg_dir/repo" remote get-url --push origin 2>/dev/null)" = "$SHIP_GIT_URL" ] || ' +
      `${refuse("git configuration outside the repository (system gitconfig) rewrites the remote URL; refusing to send the credential anywhere but the recorded remote")}; ` +
      "}",
    'ship_git() { _sg_shadow && _sg_run 1 "$_sg_dir/repo" "$_sg_dir/repo" "$@"; }',
    'ship_git_plain() { _sg_shadow && _sg_run 0 "$_sg_dir/repo" "$_sg_dir/repo" "$@"; }',
    'ship_git_clone() { _sg_run 1 "$_sg_ws" "" "$@"; }',
    'ship_git_here() { _sg_run 0 "$_sg_ws" "" "$@"; }',
    body,
  ].join("\n");
}
