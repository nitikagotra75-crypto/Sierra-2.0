/**
 * ASP.NET Core generator (.NET 8, controllers, EF Core + SQLite, JWT bearer, BCrypt, Swashbuckle for
 * /openapi.json, prometheus-net for /metrics, xUnit + WebApplicationFactory tests).
 *
 * Neither the .NET SDK nor NuGet is available in the environment where this generator was written, so projects
 * from it have never been compiled or run by Sierra (not even a syntax check). Validation reports "skipped" when
 * the SDK is missing or packages cannot be restored.
 */
const j = (v) => JSON.stringify(v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const cls = (e) => cap(e.name.replace(/[^A-Za-z0-9]/g, ""));
const prop = (f) => cap(f.name);
const CS = { string: "string", text: "string", int: "long", float: "double", bool: "bool", enum: "string" };
const csLit = (s) => JSON.stringify(String(s)); // JSON string literals are valid C# string literals for our inputs
const sample = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return JSON.stringify(`${f.name} ${n}`);
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "true";
    case "enum": return JSON.stringify(f.values[0]);
  }
};

function attrs(f, forUpdate) {
  const out = [`[JsonPropertyName(${csLit(f.name)})]`];
  const mustHave = f.required && !forUpdate && f.default === undefined;
  if (f.type === "string") {
    if (f.required) out.push(forUpdate ? '[RegularExpression(@".*\\S.*", ErrorMessage = "must not be blank")]' : '[Required(AllowEmptyStrings = false)]', ...(forUpdate ? [] : ['[RegularExpression(@".*\\S.*", ErrorMessage = "must not be blank")]']));
    out.push("[StringLength(255)]");
  } else if (f.type === "text") {
    if (mustHave) out.push("[Required]");
    out.push("[StringLength(10000)]");
  } else if (f.type === "enum") {
    if (mustHave) out.push("[Required]");
    out.push(`[RegularExpression(${csLit("^(" + f.values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$")}, ErrorMessage = ${csLit("must be one of " + f.values.join(", "))})]`);
  } else if (mustHave) out.push("[Required]");
  return out;
}

function entityFiles(spec, e) {
  const A = spec.needsAuth;
  const C = cls(e);
  const files = {};
  const ent = e.fields.map((f) => `    [JsonPropertyName(${csLit(f.name)})]${f.required ? "\n    [Required]" : ""}\n    public ${CS[f.type]}${f.required || f.type === "string" || f.type === "text" || f.type === "enum" ? "" : "?"} ${prop(f)} { get; set; }`).join("\n\n");
  // EF maps value-typed required columns as NOT NULL; optional value types are nullable.
  files[`src/Api/Entities/${C}.cs`] = `using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace App.Entities;

public class ${C}
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

${ent}
${A ? `
    [JsonPropertyName("owner_id")]
    public long OwnerId { get; set; }
` : ""}
    [JsonPropertyName("created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
`;
  const reqProps = e.fields.map((f) => `    ${attrs(f, false).join("\n    ")}\n    public ${CS[f.type]}${f.type === "string" || f.type === "text" || f.type === "enum" ? "" : "?"} ${prop(f)} { get; set; }`).join("\n\n");
  const updProps = e.fields.map((f) => `    ${attrs(f, true).join("\n    ")}\n    public ${CS[f.type]}${f.type === "string" || f.type === "text" || f.type === "enum" ? "" : "?"} ${prop(f)} { get; set; }`).join("\n\n");
  files[`src/Api/Entities/${C}Dtos.cs`] = `using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace App.Entities;

/// <summary>Body of POST /api/${e.plural}. Unknown properties are rejected.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class ${C}Request
{
${reqProps}
}

/// <summary>Body of PUT /api/${e.plural}/{id}: every field is optional; only the ones sent change.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class ${C}Update
{
${updProps}
}
`;
  const defaults = e.fields.filter((f) => f.default !== undefined && f.default !== "").map((f) => {
    const lit = f.type === "string" || f.type === "text" || f.type === "enum" ? csLit(f.default) : f.type === "int" ? `${Number(f.default)}L` : f.type === "float" ? `${Number(f.default)}d` : String(!!f.default);
    const nullable = f.type === "string" || f.type === "text" || f.type === "enum";
    return `        ${nullable ? `if (in_.${prop(f)} == null)` : `if (!in_.${prop(f)}.HasValue)`} in_.${prop(f)} = ${lit};`;
  }).join("\n");
  const copy = e.fields.map((f) => {
    const valueType = !(f.type === "string" || f.type === "text" || f.type === "enum");
    return `            ${prop(f)} = in_.${prop(f)}${valueType ? (f.required ? ".GetValueOrDefault()" : "") : ""},`;
  }).join("\n");
  const apply = e.fields.map((f) => {
    const valueType = !(f.type === "string" || f.type === "text" || f.type === "enum");
    return valueType ? `        if (in_.${prop(f)}.HasValue) cur.${prop(f)} = in_.${prop(f)}.Value;` : `        if (in_.${prop(f)} != null) cur.${prop(f)} = in_.${prop(f)};`;
  }).join("\n");
  files[`src/Api/Services/${C}Service.cs`] = `using App.Common;
using App.Data;
using App.Entities;
using Microsoft.EntityFrameworkCore;

namespace App.Services;

public class ${C}Service
{
    private readonly AppDbContext _db;

    public ${C}Service(AppDbContext db) => _db = db;

    public async Task<List<${C}>> List(long? ownerId, int limit, int offset)
    {
        IQueryable<${C}> q = _db.Set<${C}>().AsNoTracking();
${A ? "        q = q.Where(x => x.OwnerId == ownerId);\n" : ""}        return await q.OrderByDescending(x => x.Id).Skip(offset).Take(limit).ToListAsync();
    }

    public async Task<${C}> Get(long id, long? ownerId)
    {
        var v = await _db.Set<${C}>().FirstOrDefaultAsync(x => x.Id == id${A ? " && x.OwnerId == ownerId" : ""});
        return v ?? throw AppException.NotFound(${csLit(e.name)});
    }

    public async Task<${C}> Create(${C}Request in_, long? ownerId)
    {
${defaults}
        var v = new ${C}
        {
${copy}
${A ? "            OwnerId = ownerId.GetValueOrDefault(),\n" : ""}            CreatedAt = DateTime.UtcNow,
        };
        _db.Add(v);
        await _db.SaveChangesAsync();
        return v;
    }

    public async Task<${C}> Update(long id, ${C}Update in_, long? ownerId)
    {
        var cur = await Get(id, ownerId);
${apply}
        await _db.SaveChangesAsync();
        return cur;
    }

    public async Task Delete(long id, long? ownerId)
    {
        var cur = await Get(id, ownerId);
        _db.Remove(cur);
        await _db.SaveChangesAsync();
    }
}
`;
  files[`src/Api/Controllers/${C}Controller.cs`] = `using App.Common;
using App.Entities;
using App.Services;
${A ? "using Microsoft.AspNetCore.Authorization;\n" : ""}using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

[ApiController]
[Route(${csLit("api/" + e.plural)})]
${A ? "[Authorize]\n" : ""}public class ${C}Controller : ApiControllerBase
{
    private readonly ${C}Service _service;

    public ${C}Controller(${C}Service service) => _service = service;

    [HttpGet]
    public async Task<ActionResult<List<${C}>>> List([FromQuery] int limit = 50, [FromQuery] int offset = 0)
    {
        if (limit < 1 || limit > 200) throw AppException.Validation("limit", "must be between 1 and 200");
        if (offset < 0) throw AppException.Validation("offset", "must be >= 0");
        return await _service.List(OwnerId, limit, offset);
    }

    [HttpPost]
    public async Task<ActionResult<${C}>> Create([FromBody] ${C}Request body)
    {
        var v = await _service.Create(body, OwnerId);
        return StatusCode(StatusCodes.Status201Created, v);
    }

    [HttpGet("{id:long}")]
    public async Task<ActionResult<${C}>> Get(long id) => await _service.Get(id, OwnerId);

    [HttpPut("{id:long}")]
    public async Task<ActionResult<${C}>> Update(long id, [FromBody] ${C}Update body) => await _service.Update(id, body, OwnerId);

    [HttpDelete("{id:long}")]
    public async Task<IActionResult> Delete(long id)
    {
        await _service.Delete(id, OwnerId);
        return NoContent();
    }
}
`;
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const payload = "{ " + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `"${f.name}": ${sample(f, 1)}`).join(", ") + " }";
  const upd = first.type === "string" ? `{ "${first.name}": "changed" }` : `{ "${first.name}": ${sample(first, 9)} }`;
  const updExpect = first.type === "string" ? `Assert.Equal("changed", updated.GetProperty(${csLit(first.name)}).GetString());` : `Assert.Equal(${first.type === "bool" ? "true" : sample(first, 9)}, updated.GetProperty(${csLit(first.name)}).${first.type === "int" ? "GetInt64()" : first.type === "float" ? "GetDouble()" : first.type === "bool" ? "GetBoolean()" : "GetString()"});`;
  const base = "/api/" + e.plural;
  const authLine = A ? "        var http = await app.Authed(\"user\");\n" : "        var http = app.CreateClient();\n";
  files[`tests/Api.Tests/${C}Tests.cs`] = `using System.Net;
using System.Text.Json;
using Xunit;

namespace Api.Tests;

public class ${C}Tests : IClassFixture<TestApp>
{
    private readonly TestApp app;

    public ${C}Tests(TestApp app) => this.app = app;

    [Fact]
    public async Task Crud()
    {
${authLine}        var created = await http.PostAsync(${csLit(base)}, Json.Body("""${payload}"""));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await Json.Read(created)).GetProperty("id").GetInt64();
        var list = await Json.Read(await http.GetAsync(${csLit(base)}));
        Assert.Contains(list.EnumerateArray(), x => x.GetProperty("id").GetInt64() == id);
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"${base}/{id}")).StatusCode);
        var put = await http.PutAsync($"${base}/{id}", Json.Body("""${upd}"""));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var updated = await Json.Read(put);
        ${updExpect}
        Assert.Equal(HttpStatusCode.NoContent, (await http.DeleteAsync($"${base}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"${base}/{id}")).StatusCode);
    }

    [Fact]
    public async Task ValidationErrorsUseTheStandardShape()
    {
${authLine}        var bad = await http.PostAsync(${csLit(base)}, Json.Body("{}"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.StatusCode);
        Assert.Equal("validation_error", (await Json.Read(bad)).GetProperty("error").GetProperty("code").GetString());
        var extra = await http.PostAsync(${csLit(base)}, Json.Body("""${payload.replace(/ }$/, ', "unexpected": 1 }')}"""));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, extra.StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await http.GetAsync(${csLit(base + "?limit=0")})).StatusCode);
    }
${A ? `
    [Fact]
    public async Task RequiresAuthAndIsIsolatedPerUser()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await app.CreateClient().GetAsync(${csLit(base)})).StatusCode);
        var one = await app.Authed("one");
        var created = await one.PostAsync(${csLit(base)}, Json.Body("""${payload}"""));
        var id = (await Json.Read(created)).GetProperty("id").GetInt64();
        var two = await app.Authed("two");
        Assert.Equal(HttpStatusCode.NotFound, (await two.GetAsync($"${base}/{id}")).StatusCode);
    }
` : ""}}
`;
  return files;
}

function generate(spec) {
  const A = spec.needsAuth;
  const f = {};
  f["src/Api/Api.csproj"] = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>App</RootNamespace>
    <AssemblyName>Api</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="8.0.10" />
${A ? `    <PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="8.0.10" />
    <PackageReference Include="BCrypt.Net-Next" Version="4.0.3" />
` : ""}    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.8.1" />
    <PackageReference Include="prometheus-net.AspNetCore" Version="8.2.1" />
  </ItemGroup>
</Project>
`;
  f["tests/Api.Tests/Api.Tests.csproj"] = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
    <RootNamespace>Api.Tests</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.10" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../src/Api/Api.csproj" />
  </ItemGroup>
</Project>
`;
  f["src/Api/Common/AppException.cs"] = `namespace App.Common;

public class AppException : Exception
{
    public int Status { get; }
    public string Code { get; }
    public object Details { get; }

    public AppException(int status, string code, string message, object details = null) : base(message)
    {
        Status = status;
        Code = code;
        Details = details;
    }

    public static AppException NotFound(string what) => new(404, "not_found", what + " not found");
    public static AppException Conflict(string msg) => new(409, "conflict", msg);
    public static AppException Unauthorized(string msg) => new(401, "unauthorized", msg);
    public static AppException Validation(string loc, string msg) =>
        new(422, "validation_error", "Request validation failed", new[] { new { loc, msg } });
}
`;
  f["src/Api/Common/ErrorMiddleware.cs"] = `using System.Text.Json;

namespace App.Common;

/// <summary>Every error leaves the API as {"error": {"code", "message", "details"}}.</summary>
public class ErrorMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ErrorMiddleware> _log;

    public ErrorMiddleware(RequestDelegate next, ILogger<ErrorMiddleware> log)
    {
        _next = next;
        _log = log;
    }

    public static Task Write(HttpResponse res, int status, string code, string message, object details = null)
    {
        res.StatusCode = status;
        res.ContentType = "application/json";
        return res.WriteAsync(JsonSerializer.Serialize(new { error = new { code, message, details } }));
    }

    public async Task Invoke(HttpContext ctx)
    {
        try
        {
            await _next(ctx);
        }
        catch (AppException e) when (!ctx.Response.HasStarted)
        {
            await Write(ctx.Response, e.Status, e.Code, e.Message, e.Details);
        }
        catch (BadHttpRequestException e) when (!ctx.Response.HasStarted)
        {
            await Write(ctx.Response, 422, "validation_error", "Request validation failed", new[] { new { msg = e.Message } });
        }
        catch (Exception e) when (!ctx.Response.HasStarted)
        {
            _log.LogError(e, "unhandled error");
            await Write(ctx.Response, 500, "internal_error", "Internal server error");
        }
    }
}
`;
  f["src/Api/Common/ApiControllerBase.cs"] = `using Microsoft.AspNetCore.Mvc;

namespace App.Common;

public abstract class ApiControllerBase : ControllerBase
{
    /// <summary>The authenticated user's id, or null when the API has no auth.</summary>
    protected long? OwnerId => User?.Identity?.IsAuthenticated == true && long.TryParse(User.FindFirst("sub")?.Value, out var id) ? id : null;
}
`;
  f["src/Api/Data/AppDbContext.cs"] = `using App.Entities;
using Microsoft.EntityFrameworkCore;

namespace App.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
${A ? "\n    public DbSet<User> Users => Set<User>();\n" : ""}
    protected override void OnModelCreating(ModelBuilder b)
    {
${A ? '        b.Entity<User>().ToTable("users").HasIndex(u => u.Email).IsUnique();\n' : ""}${spec.entities.map((e) => `        b.Entity<${cls(e)}>().ToTable(${csLit(e.plural.replace(/-/g, "_"))});`).join("\n")}
    }
}
`;
  if (A) {
    f["src/Api/Entities/User.cs"] = `using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace App.Entities;

public class User
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

    [JsonPropertyName("email")]
    [Required]
    public string Email { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonIgnore]
    public string PasswordHash { get; set; }

    [JsonPropertyName("created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
`;
    f["src/Api/Controllers/AuthController.cs"] = `using System.ComponentModel.DataAnnotations;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json.Serialization;
using App.Common;
using App.Data;
using App.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace App.Controllers;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class RegisterRequest
{
    [JsonPropertyName("email")] [Required] [EmailAddress] [StringLength(255)] public string Email { get; set; }
    [JsonPropertyName("name")] [StringLength(255)] public string Name { get; set; }
    [JsonPropertyName("password")] [Required] [StringLength(72, MinimumLength = 8)] public string Password { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class LoginRequest
{
    [JsonPropertyName("email")] [Required] public string Email { get; set; }
    [JsonPropertyName("password")] [Required] public string Password { get; set; }
}

[ApiController]
[Route("api/auth")]
public class AuthController : ApiControllerBase
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _cfg;

    public AuthController(AppDbContext db, IConfiguration cfg)
    {
        _db = db;
        _cfg = cfg;
    }

    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest body)
    {
        var email = body.Email.Trim().ToLowerInvariant();
        if (await _db.Users.AnyAsync(u => u.Email == email)) throw AppException.Conflict("Email already registered");
        var u = new User { Email = email, Name = body.Name ?? "", PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password) };
        _db.Users.Add(u);
        await _db.SaveChangesAsync();
        return StatusCode(StatusCodes.Status201Created, u);
    }

    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest body)
    {
        var email = body.Email.Trim().ToLowerInvariant();
        var u = await _db.Users.FirstOrDefaultAsync(x => x.Email == email);
        if (u == null || !BCrypt.Net.BCrypt.Verify(body.Password, u.PasswordHash)) throw AppException.Unauthorized("Invalid email or password");
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_cfg["Jwt:Secret"]));
        var token = new JwtSecurityToken(
            claims: new[] { new Claim("sub", u.Id.ToString()) },
            expires: DateTime.UtcNow.AddHours(1),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return Ok(new { access_token = new JwtSecurityTokenHandler().WriteToken(token), token_type = "bearer" });
    }

    [HttpGet("me")]
    [Authorize]
    public async Task<IActionResult> Me()
    {
        var u = await _db.Users.FindAsync(OwnerId);
        return u == null ? throw AppException.Unauthorized("Invalid or missing credentials") : Ok(u);
    }
}
`;
  }
  f["src/Api/Program.cs"] = `using System.Text;
using App.Common;
using App.Data;
${A ? "using Microsoft.AspNetCore.Authentication.JwtBearer;\nusing Microsoft.IdentityModel.Tokens;\n" : ""}using Microsoft.EntityFrameworkCore;
using Microsoft.OpenApi.Models;
using Prometheus;

var builder = WebApplication.CreateBuilder(args);

var connection = builder.Configuration.GetConnectionString("Default") ?? "Data Source=data/app.db";
Directory.CreateDirectory("data");
builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlite(connection));
${spec.entities.map((e) => `builder.Services.AddScoped<App.Services.${cls(e)}Service>();`).join("\n")}

builder.Services.AddControllers().ConfigureApiBehaviorOptions(o =>
{
    // Model-binding and validation failures use the same error shape (and 422) as every other error.
    o.InvalidModelStateResponseFactory = ctx =>
    {
        var details = ctx.ModelState.Where(kv => kv.Value.Errors.Count > 0)
            .SelectMany(kv => kv.Value.Errors.Select(err => new { loc = kv.Key, msg = string.IsNullOrEmpty(err.ErrorMessage) ? "invalid value" : err.ErrorMessage })).ToArray();
        return new Microsoft.AspNetCore.Mvc.ObjectResult(new { error = new { code = "validation_error", message = "Request validation failed", details } }) { StatusCode = 422 };
    };
});
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("openapi", new OpenApiInfo { Title = ${csLit(spec.name)}, Version = "1.0.0" });
${A ? `    c.AddSecurityDefinition("bearer", new OpenApiSecurityScheme { Type = SecuritySchemeType.Http, Scheme = "bearer", BearerFormat = "JWT" });
    c.AddSecurityRequirement(new OpenApiSecurityRequirement { { new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "bearer" } }, Array.Empty<string>() } });
` : ""}});
${A ? `
// The signing secret comes from the environment (Jwt__Secret) and is never committed.
var secret = builder.Configuration["Jwt:Secret"] ?? "";
if (secret.Length < 32) throw new InvalidOperationException("Jwt__Secret must be set to at least 32 characters");
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = false,
        ValidateAudience = false,
        ValidateLifetime = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
        ClockSkew = TimeSpan.Zero,
    };
    o.Events = new JwtBearerEvents
    {
        OnChallenge = async ctx =>
        {
            ctx.HandleResponse();
            await ErrorMiddleware.Write(ctx.Response, 401, "unauthorized", "Invalid or missing credentials");
        },
        OnTokenValidated = async ctx =>
        {
            var db = ctx.HttpContext.RequestServices.GetRequiredService<AppDbContext>();
            if (!long.TryParse(ctx.Principal?.FindFirst("sub")?.Value, out var id) || !await db.Users.AnyAsync(u => u.Id == id))
                ctx.Fail("unknown user");
        },
    };
});
builder.Services.AddAuthorization();
` : ""}
var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    // No migrations are generated: the schema is created on first start. Use EF migrations for real deployments.
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();
}

app.UseMiddleware<ErrorMiddleware>();
app.UseHttpMetrics();
app.UseSwagger(c => c.RouteTemplate = "{documentName}.json"); // serves /openapi.json
${A ? "app.UseAuthentication();\napp.UseAuthorization();\n" : ""}
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapMetrics("/metrics");
app.MapControllers();
app.MapFallback(ctx => ErrorMiddleware.Write(ctx.Response, 404, "http_error", "Route not found"));

app.Run();

public partial class Program { } // makes the entry point visible to WebApplicationFactory in the test project
`;
  f["tests/Api.Tests/TestApp.cs"] = `using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Api.Tests;

public static class Json
{
    public static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    public static async Task<JsonElement> Read(HttpResponseMessage res)
    {
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }
}

/// <summary>Boots the real app against a throw-away SQLite file. Settings go through environment variables so they are
/// visible to Program.cs, which reads configuration while the host is being built.</summary>
public class TestApp : WebApplicationFactory<Program>
{
    public TestApp()
    {
        Environment.SetEnvironmentVariable("ConnectionStrings__Default", "Data Source=" + Path.Combine(Path.GetTempPath(), "api-test-" + Guid.NewGuid() + ".db"));
        Environment.SetEnvironmentVariable("Jwt__Secret", "test-secret-not-for-production-0123456789");
    }
${A ? `
    /// <summary>A client with a fresh user's bearer token.</summary>
    public async Task<HttpClient> Authed(string label)
    {
        var http = CreateClient();
        var email = label + "-" + Guid.NewGuid() + "@example.com";
        var body = "{\\"email\\": \\"" + email + "\\", \\"password\\": \\"password123\\"}";
        await http.PostAsync("/api/auth/register", Json.Body(body));
        var login = await Json.Read(await http.PostAsync("/api/auth/login", Json.Body(body)));
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.GetProperty("access_token").GetString());
        return http;
    }
` : ""}}
`;
  f["tests/Api.Tests/PlatformTests.cs"] = `using System.Net;
using Xunit;

namespace Api.Tests;

public class PlatformTests : IClassFixture<TestApp>
{
    private readonly TestApp app;

    public PlatformTests(TestApp app) => this.app = app;

    [Fact]
    public async Task HealthOpenApiMetricsAndStandardNotFound()
    {
        var http = app.CreateClient();
        var health = await Json.Read(await http.GetAsync("/health"));
        Assert.Equal("ok", health.GetProperty("status").GetString());
        var spec = await Json.Read(await http.GetAsync("/openapi.json"));
        Assert.True(spec.TryGetProperty("openapi", out _));
        Assert.True(spec.GetProperty("paths").TryGetProperty("/health", out _) || spec.GetProperty("paths").EnumerateObject().Any());
        var metrics = await (await http.GetAsync("/metrics")).Content.ReadAsStringAsync();
        Assert.Contains("http_requests_received_total", metrics);
        var missing = await http.GetAsync("/nope");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("http_error", (await Json.Read(missing)).GetProperty("error").GetProperty("code").GetString());
    }
}
`;
  if (A) f["tests/Api.Tests/AuthTests.cs"] = `using System.Net;
using Xunit;

namespace Api.Tests;

public class AuthTests : IClassFixture<TestApp>
{
    private readonly TestApp app;

    public AuthTests(TestApp app) => this.app = app;

    private static string Creds(string email, string password) => "{\\"email\\": \\"" + email + "\\", \\"password\\": \\"" + password + "\\"}";

    [Fact]
    public async Task RegisterLoginMeAndNoPasswordLeak()
    {
        var http = app.CreateClient();
        var reg = await http.PostAsync("/api/auth/register", Json.Body(Creds("a@example.com", "password123")));
        Assert.Equal(HttpStatusCode.Created, reg.StatusCode);
        Assert.DoesNotContain("password", (await reg.Content.ReadAsStringAsync()).ToLowerInvariant());
        var login = await http.PostAsync("/api/auth/login", Json.Body(Creds("a@example.com", "password123")));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var token = (await Json.Read(login)).GetProperty("access_token").GetString();
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var me = await Json.Read(await http.GetAsync("/api/auth/me"));
        Assert.Equal("a@example.com", me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task DuplicateWeakPasswordBadLoginBadToken()
    {
        var http = app.CreateClient();
        var ok = Creds("d@example.com", "password123");
        Assert.Equal(HttpStatusCode.Created, (await http.PostAsync("/api/auth/register", Json.Body(ok))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.PostAsync("/api/auth/register", Json.Body(ok))).StatusCode);
        var weak = await http.PostAsync("/api/auth/register", Json.Body(Creds("w@example.com", "short")));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, weak.StatusCode);
        Assert.Equal("validation_error", (await Json.Read(weak)).GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.PostAsync("/api/auth/login", Json.Body(Creds("d@example.com", "wrong-password")))).StatusCode);
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "nope");
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.GetAsync("/api/auth/me")).StatusCode);
    }
}
`;
  for (const e of spec.entities) Object.assign(f, entityFiles(spec, e));
  f[".env.example"] = ["ASPNETCORE_HTTP_PORTS=8080", "ConnectionStrings__Default=Data Source=data/app.db", ...(A ? ["Jwt__Secret=changeme_use_a_long_random_secret_of_32_chars_or_more"] : [])].join("\n") + "\n";
  f["Dockerfile"] = `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/Api/Api.csproj src/Api/
RUN dotnet restore src/Api/Api.csproj
COPY src/Api src/Api
RUN dotnet publish src/Api/Api.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
RUN mkdir -p /app/data && chown -R $APP_UID /app/data
USER $APP_UID
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
`;
  f["docker-compose.yml"] = `services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      ConnectionStrings__Default: Data Source=/app/data/app.db
${A ? "      Jwt__Secret: ${JWT_SECRET:?set JWT_SECRET (32+ chars) in your shell or .env}\n" : ""}    volumes:
      - appdata:/app/data
volumes:
  appdata:
`;
  f[".dockerignore"] = "**/bin\n**/obj\n**/data\n.env\n";
  f[".gitignore"] = "bin/\nobj/\ndata/\n.env\n";
  f["README.md"] = `# ${spec.name}

ASP.NET Core 8 (controllers) backend generated by Sierra. Layers: \`controller -> service -> EF Core (SQLite)\`; DataAnnotations validation; JWT bearer auth with BCrypt password hashes.

## Run
\`\`\`
${A ? "export Jwt__Secret=$(openssl rand -hex 32)\n" : ""}dotnet run --project src/Api
\`\`\`
Requires the .NET 8 SDK. Listens on the port in \`ASPNETCORE_HTTP_PORTS\` / \`ASPNETCORE_URLS\`. OpenAPI: \`GET /openapi.json\` (Swashbuckle). Metrics: \`GET /metrics\` (prometheus-net).

## Test
\`\`\`
dotnet test tests/Api.Tests/Api.Tests.csproj
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\`
${A ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/{id}\``).join("\n")}

## Known limitations
- **Never compiled by Sierra.** The .NET SDK and NuGet were not available where this project was generated, so it has not even been built there. Run \`dotnet test\` yourself and expect to fix small compile errors before relying on it.
- SQLite only; the schema is created with \`EnsureCreated()\` at startup and there are no EF migrations.
- No refresh tokens or rate limiting. \`MapInboundClaims\` is off, so the user id is read from the \`sub\` claim.
`;
  return f;
}

module.exports = {
  id: "aspnet-core",
  label: ".NET ASP.NET Core",
  language: "C#",
  framework: "ASP.NET Core",
  status: "implemented",
  databases: ["sqlite"],
  notes: ".NET 8, EF Core + SQLite. Never compiled by Sierra (no .NET SDK in its build environment).",
  generate,
  validate: {
    toolchain: "dotnet",
    format: [{ cmd: ["dotnet", "format", "--verify-no-changes", "--no-restore", "tests/Api.Tests/Api.Tests.csproj"] }],
    setup: [["dotnet", "restore", "tests/Api.Tests/Api.Tests.csproj"]],
    build: [["dotnet", "build", "tests/Api.Tests/Api.Tests.csproj", "--no-restore"]],
    test: [["dotnet", "test", "tests/Api.Tests/Api.Tests.csproj", "--no-restore"]],
    offlineMeansSkipped: true,
  },
};
