#!/usr/bin/env python3
"""Builds a local file:// GOPROXY from Debian's golang-*-dev packages (/usr/share/gocode/src).

Why: in an environment where proxy.golang.org is blocked but apt works, this lets `go build` / `go test` resolve the exact
module versions the generated Go projects pin. It is only a test harness: generated projects still pin the real versions and
resolve them from the real proxy in CI/production. Usage:  build-go-proxy.py OUTDIR
Each module's require block is dropped from the served .mod (those test-only deps are not packaged here)."""
import os, re, sys, zipfile, json

MODULES = {
    "github.com/lib/pq": "v1.10.9",
    "github.com/go-sql-driver/mysql": "v1.7.1",
    "github.com/gomodule/redigo": "v1.8.9",
    "github.com/rabbitmq/amqp091-go": "v1.9.0",
}
# Web frameworks: Debian ships Gin 1.8.1 (+ its dependencies), served under the version labels the generated go.mod pins.
# The compiled code is therefore Gin 1.8.1, NOT v1.10.0: this verifies Sierra's Gin layer compiles and runs against a
# real Gin, but not against the exact pinned release (CI resolves the real one). Fiber is not packaged by Debian.
# value = (version label, source dir under SRC when it differs from the module path)
EXTRA = {
    "github.com/gin-gonic/gin": ("v1.10.0", None),
    "github.com/gin-contrib/sse": ("v0.1.0", None),
    "github.com/go-playground/validator/v10": ("v10.20.0", None),
    "github.com/go-playground/locales": ("v0.14.1", None),
    "github.com/go-playground/universal-translator": ("v0.18.1", None),
    "github.com/leodido/go-urn": ("v1.4.0", None),
    "github.com/mattn/go-isatty": ("v0.0.20", None),
    "github.com/pelletier/go-toml/v2": ("v2.2.2", None),
    "github.com/ugorji/go/codec": ("v1.2.12", None),
    "golang.org/x/net": ("v0.25.0", None),
    "golang.org/x/sys": ("v0.20.0", None),
    "golang.org/x/crypto": ("v0.23.0", None),
    "golang.org/x/text": ("v0.15.0", None),
    "google.golang.org/protobuf": ("v1.34.1", None),
    "gopkg.in/yaml.v3": ("v3.0.1", None),
    "gopkg.in/yaml.v2": ("v2.4.0", None),
}
for _m, (_v, _d) in EXTRA.items():
    MODULES[_m] = _v
SRC = "/usr/share/gocode/src"
out = sys.argv[1]
for mod, ver in MODULES.items():
    d = os.path.join(SRC, mod)
    if not os.path.isdir(d):
        print("missing source for", mod, "(apt install the golang-*-dev package)"); continue
    base = os.path.join(out, mod, "@v")
    os.makedirs(base, exist_ok=True)
    gomod = open(os.path.join(d, "go.mod")).read() if os.path.exists(os.path.join(d, "go.mod")) else f"module {mod}\n"
    gomod = re.sub(r"(?s)require\s*\(.*?\)\n?", "", gomod)
    gomod = re.sub(r"(?m)^require .*\n", "", gomod)
    gomod = re.sub(r"(?m)^go \d+\.\d+(\.\d+)?\n", "go 1.20\n", gomod)
    open(os.path.join(base, ver + ".mod"), "w").write(gomod)
    open(os.path.join(base, ver + ".info"), "w").write(json.dumps({"Version": ver, "Time": "2023-01-01T00:00:00Z"}))
    open(os.path.join(base, "list"), "w").write(ver + "\n")
    with zipfile.ZipFile(os.path.join(base, ver + ".zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in (".git", "testdata")]
            for f in files:
                if f == "go.mod":
                    z.writestr(f"{mod}@{ver}/go.mod", gomod); continue
                if f == "go.sum" or f.endswith("_test.go"): continue
                p = os.path.join(root, f)
                z.write(p, f"{mod}@{ver}/" + os.path.relpath(p, d))
    print("served", mod, ver)
