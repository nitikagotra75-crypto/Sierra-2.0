/**
 * NestJS generator (TypeScript, Node >= 22.13). Modules per entity, class-validator DTOs, @nestjs/swagger for
 * OpenAPI at /openapi.json, JWT guard, SQLite through node:sqlite. Layers: controller -> service -> repository.
 * Tests use @nestjs/testing + supertest under jest.
 */
const j = (v) => JSON.stringify(v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sample = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return JSON.stringify(`${f.name} ${n}`);
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "true";
    case "enum": return JSON.stringify(f.values[0]);
  }
};

function dtoFields(e, forUpdate) {
  return e.fields.map((f) => {
    const optional = forUpdate || !f.required || f.default !== undefined;
    const dec = [];
    if (optional) dec.push("@IsOptional()");
    switch (f.type) {
      case "string": dec.push("@IsString()", ...(f.required && !forUpdate ? ["@IsNotEmpty()"] : []), "@MaxLength(255)"); break;
      case "text": dec.push("@IsString()", "@MaxLength(10000)"); break;
      case "int": dec.push("@IsInt()"); break;
      case "float": dec.push("@IsNumber()"); break;
      case "bool": dec.push("@IsBoolean()"); break;
      case "enum": dec.push(`@IsIn(${j(f.values)})`); break;
    }
    const api = f.type === "enum" ? `@ApiProperty({ required: ${!optional}, enum: ${j(f.values)} })` : `@ApiProperty({ required: ${!optional} })`;
    const ts = { string: "string", text: "string", int: "number", float: "number", bool: "boolean", enum: "string" }[f.type];
    return `  ${api}\n  ${dec.join("\n  ")}\n  ${f.name}${optional ? "?" : "!"}: ${ts};`;
  }).join("\n\n");
}

function entityFiles(spec, e) {
  const A = spec.needsAuth;
  const C = cap(e.lower.replace(/[^A-Za-z0-9]/g, ""));
  const dir = `src/${e.lower}`;
  const fields = e.fields.map((f) => ({ name: f.name, type: f.type, required: !!f.required, ...(f.default !== undefined ? { default: f.default } : {}) }));
  const files = {};
  files[`${dir}/${e.lower}.dto.ts`] = `import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from "class-validator";

export class Create${C}Dto {
${dtoFields(e, false)}
}

export class Update${C}Dto {
${dtoFields(e, true)}
}
`;
  files[`${dir}/${e.lower}.service.ts`] = `import { Injectable } from "@nestjs/common";
import { CrudService } from "../common/crud.service";
import { DbService } from "../database/db.service";
import { Repository } from "../common/repository";

export const ${C}Meta = {
  table: ${j(e.plural.replace(/-/g, "_"))},
  label: ${j(e.name)},
  owned: ${A},
  fields: ${JSON.stringify(fields)},
};

@Injectable()
export class ${C}Service extends CrudService {
  constructor(db: DbService) {
    super(new Repository(db.db, ${C}Meta), ${C}Meta.label);
  }
}
`;
  files[`${dir}/${e.lower}.controller.ts`] = `import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req${A ? ", UseGuards" : ""} } from "@nestjs/common";
import { ApiTags${A ? ", ApiBearerAuth" : ""} } from "@nestjs/swagger";
${A ? 'import { AuthGuard } from "../auth/auth.guard";\n' : ""}import { PageQuery } from "../common/page.query";
import { Create${C}Dto, Update${C}Dto } from "./${e.lower}.dto";
import { ${C}Service } from "./${e.lower}.service";

@ApiTags(${j(e.name)})
${A ? "@ApiBearerAuth()\n@UseGuards(AuthGuard)\n" : ""}@Controller(${j("api/" + e.plural)})
export class ${C}Controller {
  constructor(private readonly service: ${C}Service) {}

  private owner(req: any): number | null { return ${A ? "req.user.id" : "null"}; }

  @Get()
  list(@Query() page: PageQuery, @Req() req: any) { return this.service.list(this.owner(req), page.limit ?? 50, page.offset ?? 0); }

  @Post()
  create(@Body() dto: Create${C}Dto, @Req() req: any) { return this.service.create(dto as any, this.owner(req)); }

  @Get(":id")
  get(@Param("id", ParseIntPipe) id: number, @Req() req: any) { return this.service.get(id, this.owner(req)); }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: Update${C}Dto, @Req() req: any) { return this.service.update(id, dto as any, this.owner(req)); }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number, @Req() req: any) { this.service.delete(id, this.owner(req)); }
}
`;
  files[`${dir}/${e.lower}.module.ts`] = `import { Module } from "@nestjs/common";
import { ${C}Controller } from "./${e.lower}.controller";
import { ${C}Service } from "./${e.lower}.service";

@Module({ controllers: [${C}Controller], providers: [${C}Service] })
export class ${C}Module {}
`;
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const payload = "{ " + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `${f.name}: ${sample(f, 1)}`).join(", ") + " }";
  const upd = first.type === "string" ? `{ ${first.name}: "changed" }` : `{ ${first.name}: ${sample(first, 9)} }`;
  const updCheck = first.type === "string" ? `"changed"` : sample(first, 9);
  const auth = A ? ".set(auth)" : "";
  const base = `/api/${e.plural}`;
  files[`test/${e.lower}.e2e.ts`] = `import request from "supertest";
import { createTestApp${A ? ", login" : ""} } from "./helpers";

describe(${j(e.lower)}, () => {
  it("CRUD", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    ${A ? 'const auth = await login(http, "user@example.com");\n    ' : ""}const created = await http.post(${j(base)})${auth}.send(${payload});
    expect(created.status).toBe(201);
    const id = created.body.id;
    const list = await http.get(${j(base)})${auth};
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect((await http.get(\`${base}/\${id}\`)${auth}).status).toBe(200);
    const updated = await http.put(\`${base}/\${id}\`)${auth}.send(${upd});
    expect(updated.status).toBe(200);
    expect(updated.body.${first.name}).toBe(${updCheck});
    expect((await http.delete(\`${base}/\${id}\`)${auth}).status).toBe(204);
    expect((await http.get(\`${base}/\${id}\`)${auth}).status).toBe(404);
    await app.close();
  });

  it("validation and pagination errors use the standard shape", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    ${A ? 'const auth = await login(http, "user@example.com");\n    ' : ""}const bad = await http.post(${j(base)})${auth}.send({});
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("validation_error");
    const extra = await http.post(${j(base)})${auth}.send({ ...${payload}, unexpected: 1 });
    expect(extra.status).toBe(422);
    expect((await http.get(${j(base + "?limit=0")})${auth}).status).toBe(422);
    await app.close();
  });
${A ? `
  it("requires auth and is isolated per user", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    expect((await http.get(${j(base)})).status).toBe(401);
    const one = await login(http, "one@example.com");
    const created = await http.post(${j(base)}).set(one).send(${payload});
    const two = await login(http, "two@example.com");
    expect((await http.get(\`${base}/\${created.body.id}\`).set(two)).status).toBe(404);
    await app.close();
  });
` : ""}});
`;
  return files;
}

const BASE = {
  "tsconfig.json": () => JSON.stringify({
    compilerOptions: {
      module: "commonjs", target: "ES2022", lib: ["ES2023"], outDir: "dist", rootDir: ".", declaration: false, sourceMap: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true,
      strict: true, strictPropertyInitialization: false, types: ["node", "jest"],
    },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }, null, 2) + "\n",
  "tsconfig.build.json": () => JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2) + "\n",
  "src/config.ts": (spec) => `export interface Config { port: number; host: string; dbPath: string; jwtSecret: string; }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    dbPath: env.DATABASE_PATH || "./data/app.db",
    jwtSecret: env.JWT_SECRET || "",
  };
  ${spec.needsAuth ? 'if (!cfg.jwtSecret) throw new Error("JWT_SECRET must be set");' : ""}
  return cfg;
}
`,
  "src/database/db.service.ts": () => `import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config";

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly db: DatabaseSync;

  constructor() {
    const file = loadConfig().dbPath;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  onModuleDestroy() { this.db.close(); }
}
`,
  "src/database/database.module.ts": () => `import { Global, Module } from "@nestjs/common";
import { DbService } from "./db.service";

@Global()
@Module({ providers: [DbService], exports: [DbService] })
export class DatabaseModule {}
`,
  "src/common/repository.ts": () => `import type { DatabaseSync } from "node:sqlite";

export interface FieldMeta { name: string; type: string; required: boolean; default?: unknown; }
export interface EntityMeta { table: string; label: string; owned: boolean; fields: FieldMeta[]; }

const SQL: Record<string, string> = { string: "TEXT", text: "TEXT", int: "INTEGER", float: "REAL", bool: "INTEGER", enum: "TEXT" };
// Table/column names are generation-time constants, never request data; values are always bound parameters.
const q = (id: string) => '"' + String(id).replace(/"/g, '""') + '"';

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly meta: EntityMeta) {
    const cols = meta.fields.map((f) => \`\${q(f.name)} \${SQL[f.type]}\${f.required ? " NOT NULL" : ""}\`);
    db.exec(\`CREATE TABLE IF NOT EXISTS \${q(meta.table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, \${cols.join(", ")}\${meta.owned ? ", owner_id INTEGER NOT NULL REFERENCES users(id)" : ""}, created_at TEXT NOT NULL)\`);
  }

  private out(row: any) {
    if (!row) return null;
    const out = { ...row };
    for (const f of this.meta.fields) if (f.type === "bool" && out[f.name] !== null) out[f.name] = !!out[f.name];
    return out;
  }

  private inn(f: FieldMeta, v: any) { return f.type === "bool" && v !== null && v !== undefined ? (v ? 1 : 0) : v ?? null; }

  list(ownerId: number | null, limit: number, offset: number) {
    const where = this.meta.owned ? "WHERE owner_id = ?" : "";
    const params: any[] = this.meta.owned ? [ownerId, limit, offset] : [limit, offset];
    return this.db.prepare(\`SELECT * FROM \${q(this.meta.table)} \${where} ORDER BY id DESC LIMIT ? OFFSET ?\`).all(...params).map((r) => this.out(r));
  }

  get(id: number, ownerId: number | null) {
    const where = this.meta.owned ? "AND owner_id = ?" : "";
    const params: any[] = this.meta.owned ? [id, ownerId] : [id];
    return this.out(this.db.prepare(\`SELECT * FROM \${q(this.meta.table)} WHERE id = ? \${where}\`).get(...params));
  }

  create(data: Record<string, any>, ownerId: number | null) {
    const names = this.meta.fields.map((f) => f.name);
    const values = this.meta.fields.map((f) => this.inn(f, data[f.name] !== undefined ? data[f.name] : f.default));
    const cols = [...names, ...(this.meta.owned ? ["owner_id"] : []), "created_at"].map(q);
    const params: any[] = [...values, ...(this.meta.owned ? [ownerId] : []), new Date().toISOString()];
    const info = this.db.prepare(\`INSERT INTO \${q(this.meta.table)} (\${cols.join(", ")}) VALUES (\${params.map(() => "?").join(", ")})\`).run(...params);
    return this.get(Number(info.lastInsertRowid), ownerId);
  }

  update(id: number, data: Record<string, any>, ownerId: number | null) {
    const fields = this.meta.fields.filter((f) => data[f.name] !== undefined);
    if (fields.length) {
      const sets = fields.map((f) => \`\${q(f.name)} = ?\`).join(", ");
      const where = this.meta.owned ? "AND owner_id = ?" : "";
      const params: any[] = [...fields.map((f) => this.inn(f, data[f.name])), id, ...(this.meta.owned ? [ownerId] : [])];
      this.db.prepare(\`UPDATE \${q(this.meta.table)} SET \${sets} WHERE id = ? \${where}\`).run(...params);
    }
    return this.get(id, ownerId);
  }

  delete(id: number, ownerId: number | null) {
    const where = this.meta.owned ? "AND owner_id = ?" : "";
    const params: any[] = this.meta.owned ? [id, ownerId] : [id];
    this.db.prepare(\`DELETE FROM \${q(this.meta.table)} WHERE id = ? \${where}\`).run(...params);
  }
}
`,
  "src/common/crud.service.ts": () => `import { NotFoundException } from "@nestjs/common";
import { Repository } from "./repository";

export class CrudService {
  constructor(protected readonly repo: Repository, protected readonly label: string) {}

  list(ownerId: number | null, limit: number, offset: number) { return this.repo.list(ownerId, limit, offset); }

  get(id: number, ownerId: number | null) {
    const row = this.repo.get(id, ownerId);
    if (!row) throw new NotFoundException(\`\${this.label} not found\`);
    return row;
  }

  create(data: Record<string, any>, ownerId: number | null) { return this.repo.create(data, ownerId); }
  update(id: number, data: Record<string, any>, ownerId: number | null) { this.get(id, ownerId); return this.repo.update(id, data, ownerId); }
  delete(id: number, ownerId: number | null) { this.get(id, ownerId); this.repo.delete(id, ownerId); }
}
`,
  "src/common/page.query.ts": () => `import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}
`,
  "src/common/http-exception.filter.ts": () => `import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";

const CODES: Record<number, string> = { 401: "unauthorized", 404: "not_found", 409: "conflict", 422: "validation_error" };

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("HttpError");

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const r = err.getResponse() as any;
      const code = (typeof r === "object" && r.code) || CODES[status] || "http_error";
      const message = typeof r === "string" ? r : status === 422 ? "Request validation failed" : (typeof r.message === "string" ? r.message : err.message);
      return res.status(status).json({ error: { code, message, details: (typeof r === "object" && r.details) || null } });
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    return res.status(500).json({ error: { code: "internal_error", message: "Internal server error", details: null } });
  }
}
`,
  "src/app.setup.ts": (spec) => `import { INestApplication, UnprocessableEntityException, ValidationError, ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AllExceptionsFilter } from "./common/http-exception.filter";
import { registerMetrics } from "./common/metrics";

const flatten = (errs: ValidationError[], path: string[] = []): { loc: string[]; msg: string }[] =>
  errs.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((msg) => ({ loc: [...path, e.property], msg })),
    ...flatten(e.children ?? [], [...path, e.property]),
  ]);

export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: (errs) => new UnprocessableEntityException({ code: "validation_error", details: flatten(errs) }),
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle(${j(spec.name)}).setVersion("1.0.0").addBearerAuth().build());
  // Served as JSON at /openapi.json (no bundled Swagger UI assets).
  app.getHttpAdapter().get("/openapi.json", (_req: any, res: any) => res.json(doc));
  registerMetrics(app);
  return app;
}
`,
  "src/common/metrics.ts": () => `import { INestApplication } from "@nestjs/common";

const counts = new Map<string, { n: number; s: number }>();
const esc = (v: string) => v.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');

/** In-process request counters in Prometheus text format. Per process; reset on restart. */
export function registerMetrics(app: INestApplication) {
  app.use((req: any, res: any, next: () => void) => {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const route = req.route?.path ? (req.baseUrl ?? "") + req.route.path : "unmatched";
      const key = JSON.stringify([req.method, route, String(res.statusCode)]);
      const cur = counts.get(key) ?? { n: 0, s: 0 };
      cur.n += 1;
      cur.s += Number(process.hrtime.bigint() - t0) / 1e9;
      counts.set(key, cur);
    });
    next();
  });
  app.getHttpAdapter().get("/metrics", (_req: any, res: any) => {
    const rows = [...counts.entries()].sort().map(([k, v]) => [JSON.parse(k) as string[], v] as const);
    const lbl = ([m, r, st]: string[]) => \`method="\${m}",route="\${esc(r)}",status="\${st}"\`;
    const out = [
      "# HELP http_requests_total Requests handled, by method, route template and status.",
      "# TYPE http_requests_total counter",
      ...rows.map(([k, v]) => \`http_requests_total{\${lbl(k)}} \${v.n}\`),
      "# HELP http_request_duration_seconds_sum Total time spent handling requests.",
      "# TYPE http_request_duration_seconds_sum counter",
      ...rows.map(([k, v]) => \`http_request_duration_seconds_sum{\${lbl(k)}} \${v.s.toFixed(6)}\`),
    ];
    res.type("text/plain; version=0.0.4").send(out.join("\\n") + "\\n");
  });
}
`,
  "src/health.controller.ts": () => `import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

@ApiTags("meta")
@Controller("health")
export class HealthController {
  @Get() health() { return { status: "ok" }; }
}
`,
  "src/main.ts": () => `import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { loadConfig } from "./config";

async function main() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.port, cfg.host);
}
main().catch((err) => { console.error(err); process.exit(1); });
`,
  "src/auth/auth.guard.ts": () => `import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { DbService } from "../database/db.service";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly dbs: DbService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const [kind, token] = (req.headers.authorization ?? "").split(" ");
    if (kind !== "Bearer" || !token) throw new UnauthorizedException("Invalid or missing credentials");
    let payload: { sub: string };
    try { payload = await this.jwt.verifyAsync(token); } catch { throw new UnauthorizedException("Invalid or missing credentials"); }
    const user = this.dbs.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub));
    if (!user) throw new UnauthorizedException("Invalid or missing credentials");
    req.user = user;
    return true;
  }
}
`,
  "src/auth/auth.dto.ts": () => `import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class RegisterDto {
  @ApiProperty() @IsEmail() @MaxLength(255) email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) name?: string;
  @ApiProperty({ minLength: 8, maxLength: 72 }) @IsString() @MinLength(8) @MaxLength(72) password!: string;
}

export class LoginDto {
  @ApiProperty() @IsString() email!: string;
  @ApiProperty() @IsString() password!: string;
}
`,
  "src/auth/auth.controller.ts": () => `import { Body, ConflictException, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import * as bcrypt from "bcryptjs";
import { DbService } from "../database/db.service";
import { AuthGuard } from "./auth.guard";
import { LoginDto, RegisterDto } from "./auth.dto";

const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });

@ApiTags("auth")
@Controller("api/auth")
export class AuthController {
  constructor(private readonly dbs: DbService, private readonly jwt: JwtService) {
    dbs.db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
  }

  @Post("register")
  register(@Body() dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (this.dbs.db.prepare("SELECT id FROM users WHERE email = ?").get(email)) throw new ConflictException("Email already registered");
    const info = this.dbs.db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(email, dto.name ?? "", bcrypt.hashSync(dto.password, 10), new Date().toISOString());
    return publicUser(this.dbs.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid)));
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const u: any = this.dbs.db.prepare("SELECT * FROM users WHERE email = ?").get(dto.email.toLowerCase());
    if (!u || !bcrypt.compareSync(dto.password, u.password_hash)) throw new UnauthorizedException("Invalid email or password");
    return { access_token: await this.jwt.signAsync({ sub: String(u.id) }, { expiresIn: "1h" }), token_type: "bearer" };
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  me(@Req() req: any) { return publicUser(req.user); }
}
`,
  "src/auth/auth.module.ts": () => `import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { loadConfig } from "../config";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";

@Global()
@Module({
  imports: [JwtModule.registerAsync({ global: true, useFactory: () => ({ secret: loadConfig().jwtSecret }) })],
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
`,
};

function generate(spec) {
  const f = {};
  const A = spec.needsAuth;
  const C = (e) => cap(e.lower.replace(/[^A-Za-z0-9]/g, ""));
  f["package.json"] = JSON.stringify({
    name: spec.slug, version: "1.0.0", private: true, engines: { node: ">=22.13" },
    scripts: { build: "tsc -p tsconfig.build.json", start: "node dist/main.js", "start:dev": "tsc -p tsconfig.build.json --watch", test: "jest --runInBand" },
    dependencies: {
      "@nestjs/common": "^11.0.0", "@nestjs/core": "^11.0.0", "@nestjs/platform-express": "^11.0.0", "@nestjs/swagger": "^11.0.0",
      "class-transformer": "^0.5.1", "class-validator": "^0.14.1", "reflect-metadata": "^0.2.2", rxjs: "^7.8.1",
      ...(A ? { "@nestjs/jwt": "^11.0.0", bcryptjs: "^2.4.3" } : {}),
    },
    devDependencies: {
      "@nestjs/testing": "^11.0.0", "@types/express": "^5.0.0", "@types/jest": "^29.5.12", "@types/node": "^22.10.0", "@types/supertest": "^6.0.2",
      jest: "^29.7.0", supertest: "^7.0.0", "ts-jest": "^29.2.5", typescript: "^5.6.0",
      ...(A ? { "@types/bcryptjs": "^2.4.6" } : {}),
    },
    jest: {
      preset: "ts-jest", testEnvironment: "node", testRegex: "test/.*\\.e2e\\.ts$", setupFiles: ["<rootDir>/test/setup.ts"],
      transform: { "^.+\\.ts$": ["ts-jest", { diagnostics: { ignoreCodes: [151001] } }] },
    },
  }, null, 2) + "\n";
  for (const [p, fn] of Object.entries(BASE)) f[p] = fn(spec);
  if (!A) for (const p of ["src/auth/auth.guard.ts", "src/auth/auth.dto.ts", "src/auth/auth.controller.ts", "src/auth/auth.module.ts"]) delete f[p];
  f["src/app.module.ts"] = `import "reflect-metadata";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
${A ? 'import { AuthModule } from "./auth/auth.module";\n' : ""}${spec.entities.map((e) => `import { ${C(e)}Module } from "./${e.lower}/${e.lower}.module";`).join("\n")}

@Module({
  imports: [DatabaseModule, ${A ? "AuthModule, " : ""}${spec.entities.map((e) => `${C(e)}Module`).join(", ")}],
  controllers: [HealthController],
})
export class AppModule {}
`;
  f["test/setup.ts"] = `process.env.DATABASE_PATH = ":memory:";
process.env.JWT_SECRET = "test-secret-not-for-production-0123456789";
`;
  f["test/helpers.ts"] = `import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";

export async function createTestApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(mod.createNestApplication());
  await app.init();
  return app;
}
${A ? `
export async function login(http: ReturnType<typeof request>, email: string) {
  await http.post("/api/auth/register").send({ email, password: "password123" });
  const res = await http.post("/api/auth/login").send({ email, password: "password123" });
  return { Authorization: "Bearer " + res.body.access_token };
}
` : ""}`;
  f["test/health.e2e.ts"] = `import request from "supertest";
import { createTestApp } from "./helpers";

describe("health and OpenAPI", () => {
  it("serves /health, /openapi.json and a standard 404", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    expect((await http.get("/health")).body).toEqual({ status: "ok" });
    const spec = (await http.get("/openapi.json")).body;
    expect(spec.openapi).toBeTruthy();
    expect(spec.paths["/health"]).toBeTruthy();
    const metrics = (await http.get("/metrics")).text;
    expect(metrics).toContain('http_requests_total{method="GET",route="/health",status="200"} 1');
    const missing = await http.get("/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    await app.close();
  });
});
`;
  if (A) f["test/auth.e2e.ts"] = `import request from "supertest";
import { createTestApp } from "./helpers";

describe("auth", () => {
  it("register, login, me; no password leaks", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const reg = await http.post("/api/auth/register").send({ email: "a@example.com", name: "A", password: "password123" });
    expect(reg.status).toBe(201);
    expect(JSON.stringify(reg.body)).not.toContain("password");
    const login = await http.post("/api/auth/login").send({ email: "a@example.com", password: "password123" });
    expect(login.status).toBe(200);
    const me = await http.get("/api/auth/me").set("Authorization", "Bearer " + login.body.access_token);
    expect(me.body.email).toBe("a@example.com");
    await app.close();
  });

  it("duplicate, weak password, bad login, bad token", async () => {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const body = { email: "d@example.com", password: "password123" };
    expect((await http.post("/api/auth/register").send(body)).status).toBe(201);
    expect((await http.post("/api/auth/register").send(body)).status).toBe(409);
    const weak = await http.post("/api/auth/register").send({ email: "w@example.com", password: "short" });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe("validation_error");
    expect((await http.post("/api/auth/login").send({ email: "d@example.com", password: "wrong-password" })).status).toBe(401);
    expect((await http.get("/api/auth/me").set("Authorization", "Bearer nope")).status).toBe(401);
    await app.close();
  });
});
`;
  for (const e of spec.entities) Object.assign(f, entityFiles(spec, e));
  f[".env.example"] = ["PORT=3000", "DATABASE_PATH=./data/app.db", ...(A ? ["JWT_SECRET=changeme_use_a_long_random_secret"] : [])].join("\n") + "\n";
  f["Dockerfile"] = `FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
`;
  f["docker-compose.yml"] = `services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_PATH: /app/data/app.db
${A ? "      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in your shell or .env}\n" : ""}    volumes:
      - appdata:/app/data
volumes:
  appdata:
`;
  f[".dockerignore"] = "node_modules\ndist\ndata\n.env\n";
  f[".gitignore"] = "node_modules/\ndist/\ndata/\n.env\n";
  f["README.md"] = `# ${spec.name}

NestJS (TypeScript) backend generated by Sierra. Per-entity modules: \`controller -> service -> repository\`; DTOs validated with class-validator; SQLite through Node's built-in \`node:sqlite\`.

## Run
\`\`\`
npm install
${A ? "export JWT_SECRET=$(openssl rand -hex 32)\n" : ""}npm run build && npm start
\`\`\`
Requires Node >= 22.13. OpenAPI document: \`GET /openapi.json\`.

## Test
\`\`\`
npm test
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\` (Prometheus text, per process)
${A ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/:id\``).join("\n")}

## Known limitations
- SQLite only (single node); no Postgres/MongoDB repository is generated for this stack yet.
- No migrations; tables are created at startup if missing. \`node:sqlite\` is still marked experimental by Node.
- The repository layer is synchronous (node:sqlite), which blocks the event loop under heavy load.
- bcrypt (bcryptjs) hashing and HS256 JWT; no refresh tokens or rate limiting.
`;
  return f;
}

module.exports = {
  id: "nestjs",
  label: "NestJS",
  language: "TypeScript",
  framework: "NestJS",
  status: "implemented",
  databases: ["sqlite"],
  notes: "TypeScript, SQLite via node:sqlite (Node >= 22.13). OpenAPI at /openapi.json.",
  generate,
  validate: { toolchain: "node", setup: [["npm", "install", "--no-audit", "--no-fund"]], test: [["npm", "test"]] },
};
