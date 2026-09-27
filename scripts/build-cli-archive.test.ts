import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { breakHardLinks } from "./build-cli-archive.ts";

const nlink = (fs: FileSystem.FileSystem, file: string) =>
  Effect.map(fs.stat(file), (info) => Option.getOrElse(info.nlink, () => 1));

it.live("breaks hard links into independent files, keeping content and mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "rove-hardlink-test-" });

    // esbuild's layout on macOS: a shim in one package hard-linked to the
    // native binary in another, nested below the tree root.
    const binary = path.join(root, "@esbuild/darwin-arm64/bin/esbuild");
    const shim = path.join(root, "esbuild/bin/esbuild");
    yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
    yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
    yield* fs.writeFileString(binary, "#!/bin/sh\necho native\n");
    yield* fs.chmod(binary, 0o755);
    yield* fs.link(binary, shim);
    // A plain file and a symlink must come through untouched.
    const plain = path.join(root, "plain.js");
    yield* fs.writeFileString(plain, "plain");
    const symlink = path.join(root, "link.js");
    yield* fs.symlink(plain, symlink);

    assert.equal(yield* nlink(fs, shim), 2);

    yield* breakHardLinks(fs, path, root);

    // Both paths still exist with the same bytes, but no longer share an inode.
    assert.equal(yield* nlink(fs, shim), 1);
    assert.equal(yield* nlink(fs, binary), 1);
    assert.equal(yield* fs.readFileString(shim), "#!/bin/sh\necho native\n");
    assert.equal(yield* fs.readFileString(binary), "#!/bin/sh\necho native\n");
    assert.equal(Number((yield* fs.stat(shim)).mode) & 0o777, 0o755);
    assert.equal(Number((yield* fs.stat(binary)).mode) & 0o777, 0o755);
    // Editing one no longer changes the other.
    yield* fs.writeFileString(shim, "changed");
    assert.equal(yield* fs.readFileString(binary), "#!/bin/sh\necho native\n");

    assert.equal(yield* fs.readFileString(plain), "plain");
    // Effect's stat follows symlinks, so check that the link survived and
    // still resolves to the untouched plain file rather than a copy.
    assert.isTrue(yield* fs.exists(symlink));
    assert.equal(yield* fs.realPath(symlink), yield* fs.realPath(plain));
    // Nothing temporary is left behind.
    const leftovers = (yield* fs.readDirectory(root, { recursive: true })).filter((entry) =>
      entry.endsWith(".unlink-tmp"),
    );
    assert.deepStrictEqual(leftovers, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
