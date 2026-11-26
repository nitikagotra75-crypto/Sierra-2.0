/**
 * Spring Boot generator (Java 21, Maven, Spring Boot 3.3). Layers: controller -> service -> Spring Data JPA
 * repository, H2 by default (DATABASE_URL/USERNAME/PASSWORD override it). Bean Validation DTOs, JWT (jjwt) behind
 * a HandlerInterceptor, BCrypt from spring-security-crypto, springdoc for /openapi.json, Micrometer for /metrics.
 *
 * Sierra could not download Maven artifacts in the environment where this generator was written, so projects from
 * it have never been compiled or run by Sierra; validation reports "skipped" (not "passed") when Maven cannot
 * resolve dependencies.
 */
const j = (v) => JSON.stringify(v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const JAVA_KW = new Set(["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null"]);
const JAVA_TYPE = { string: "String", text: "String", int: "Long", float: "Double", bool: "Boolean", enum: "String" };
const sample = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return JSON.stringify(`${f.name} ${n}`);
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "true";
    case "enum": return JSON.stringify(f.values[0]);
  }
};
const jstr = (s) => JSON.stringify(s); // JSON string literal is also a valid Java string literal for our inputs
const pkgOf = (e) => (JAVA_KW.has(e.lower) ? e.lower + "_" : e.lower);
const clsOf = (e) => cap(e.name.replace(/[^A-Za-z0-9]/g, ""));
const jfield = (f) => (JAVA_KW.has(f.name) ? f.name + "_" : f.name);

function constraints(f, forUpdate) {
  const out = [];
  if (f.type === "string") {
    if (f.required) out.push(forUpdate ? '@Pattern(regexp = ".*\\\\S.*", message = "must not be blank")' : "@NotBlank");
    out.push("@Size(max = 255)");
  } else if (f.type === "text") {
    if (f.required && !forUpdate) out.push("@NotNull");
    out.push("@Size(max = 10000)");
  } else if (f.type === "enum") {
    if (f.required && !forUpdate && f.default === undefined) out.push("@NotNull");
    out.push(`@Pattern(regexp = ${jstr(f.values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"))}, message = ${jstr("must be one of " + f.values.join(", "))})`);
  } else if (f.required && !forUpdate && f.default === undefined) out.push("@NotNull");
  return out;
}

function entityFiles(spec, e) {
  const A = spec.needsAuth;
  const P = pkgOf(e), C = clsOf(e);
  const dir = `src/main/java/app/${P}`;
  const files = {};
  const entityFields = e.fields.map((f) => `    @Column(nullable = ${f.required ? "false" : "true"}${f.type === "text" ? ", length = 10000" : f.type === "string" || f.type === "enum" ? ", length = 255" : ""})\n    public ${JAVA_TYPE[f.type]} ${jfield(f)};`).join("\n\n");
  files[`${dir}/${C}.java`] = `package app.${P};

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = ${j(e.plural.replace(/-/g, "_"))})
public class ${C} {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

${entityFields}
${A ? `
    @JsonProperty("owner_id")
    @Column(name = "owner_id", nullable = false)
    public Long ownerId;
` : ""}
    @JsonProperty("created_at")
    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}
`;
  files[`${dir}/${C}Repository.java`] = `package app.${P};

import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ${C}Repository extends JpaRepository<${C}, Long> {
${A ? `    Page<${C}> findByOwnerId(Long ownerId, Pageable pageable);

    Optional<${C}> findByIdAndOwnerId(Long id, Long ownerId);
` : ""}}
`;
  const createFields = e.fields.map((f) => `${constraints(f, false).map((c) => "    " + c + "\n").join("")}    public ${JAVA_TYPE[f.type]} ${jfield(f)};`).join("\n\n");
  const updateFields = e.fields.map((f) => `${constraints(f, true).map((c) => "    " + c + "\n").join("")}    public ${JAVA_TYPE[f.type]} ${jfield(f)};`).join("\n\n");
  files[`${dir}/${C}Request.java`] = `package app.${P};

import jakarta.validation.constraints.*;

/** Body of POST /api/${e.plural}. Unknown properties are rejected (spring.jackson.deserialization.fail-on-unknown-properties). */
public class ${C}Request {
${createFields}
}
`;
  files[`${dir}/${C}Update.java`] = `package app.${P};

import jakarta.validation.constraints.*;

/** Body of PUT /api/${e.plural}/{id}: every field is optional; only the ones sent are changed. */
public class ${C}Update {
${updateFields}
}
`;
  const defaults = e.fields.filter((f) => f.default !== undefined && f.default !== "").map((f) => {
    const lit = f.type === "string" || f.type === "text" || f.type === "enum" ? jstr(String(f.default)) : f.type === "int" ? `${Number(f.default)}L` : f.type === "float" ? `${Number(f.default)}d` : String(!!f.default);
    return `        if (in.${jfield(f)} == null) in.${jfield(f)} = ${lit};`;
  }).join("\n");
  const copy = e.fields.map((f) => `        v.${jfield(f)} = in.${jfield(f)};`).join("\n");
  const apply = e.fields.map((f) => `        if (in.${jfield(f)} != null) cur.${jfield(f)} = in.${jfield(f)};`).join("\n");
  files[`${dir}/${C}Service.java`] = `package app.${P};

import app.common.ApiException;
import app.common.OffsetLimit;
import java.util.List;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class ${C}Service {
    private final ${C}Repository repo;

    public ${C}Service(${C}Repository repo) {
        this.repo = repo;
    }

    @Transactional(readOnly = true)
    public List<${C}> list(Long ownerId, int limit, int offset) {
        var page = new OffsetLimit(offset, limit, Sort.by(Sort.Direction.DESC, "id"));
        return ${A ? "repo.findByOwnerId(ownerId, page)" : "repo.findAll(page)"}.getContent();
    }

    @Transactional(readOnly = true)
    public ${C} get(Long id, Long ownerId) {
        return ${A ? "repo.findByIdAndOwnerId(id, ownerId)" : "repo.findById(id)"}.orElseThrow(() -> ApiException.notFound(${jstr(e.name)}));
    }

    public ${C} create(${C}Request in, Long ownerId) {
${defaults}
        ${C} v = new ${C}();
${copy}
${A ? "        v.ownerId = ownerId;\n" : ""}        return repo.save(v);
    }

    public ${C} update(Long id, ${C}Update in, Long ownerId) {
        ${C} cur = get(id, ownerId);
${apply}
        return repo.save(cur);
    }

    public void delete(Long id, Long ownerId) {
        repo.delete(get(id, ownerId));
    }
}
`;
  files[`${dir}/${C}Controller.java`] = `package app.${P};

import app.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(${jstr("/api/" + e.plural)})
public class ${C}Controller {
    private final ${C}Service service;

    public ${C}Controller(${C}Service service) {
        this.service = service;
    }

    private static Long owner(HttpServletRequest req) {
        return (Long) req.getAttribute("uid"); // null when the API has no auth
    }

    @GetMapping
    public List<${C}> list(@RequestParam(defaultValue = "50") int limit, @RequestParam(defaultValue = "0") int offset, HttpServletRequest req) {
        if (limit < 1 || limit > 200) throw ApiException.validation("limit", "must be between 1 and 200");
        if (offset < 0) throw ApiException.validation("offset", "must be >= 0");
        return service.list(owner(req), limit, offset);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ${C} create(@Valid @RequestBody ${C}Request body, HttpServletRequest req) {
        return service.create(body, owner(req));
    }

    @GetMapping("/{id}")
    public ${C} get(@PathVariable Long id, HttpServletRequest req) {
        return service.get(id, owner(req));
    }

    @PutMapping("/{id}")
    public ${C} update(@PathVariable Long id, @Valid @RequestBody ${C}Update body, HttpServletRequest req) {
        return service.update(id, body, owner(req));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id, HttpServletRequest req) {
        service.delete(id, owner(req));
    }
}
`;
  // ---- tests
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const payload = "{ " + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `\\"${f.name}\\": ${sample(f, 1).replace(/"/g, '\\"')}`).join(", ") + " }";
  const upd = first.type === "string" ? '{ \\"' + first.name + '\\": \\"changed\\" }' : "{ \\\"" + first.name + "\\\": " + sample(first, 9).replace(/"/g, '\\"') + " }";
  const updExpect = first.type === "string" ? `jsonPath("$.${first.name}").value("changed")` : `jsonPath("$.${first.name}").value(${sample(first, 9)})`;
  const base = "/api/" + e.plural;
  const hdr = A ? '.header("Authorization", auth)' : "";
  files[`src/test/java/app/${P}/${C}ApiTest.java`] = `package app.${P};

import static org.hamcrest.Matchers.hasItem;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import app.TestSupport;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = "app.jwt.secret=test-secret-not-for-production-0123456789")
@AutoConfigureMockMvc
class ${C}ApiTest {
    @Autowired MockMvc mvc;

    @Test
    void crud() throws Exception {
${A ? "        String auth = TestSupport.login(mvc, \"user\");\n" : ""}        String created = mvc.perform(post(${jstr(base)})${hdr}.contentType(MediaType.APPLICATION_JSON).content("${payload}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        Number id = JsonPath.read(created, "$.id");
        mvc.perform(get(${jstr(base)})${hdr}).andExpect(status().isOk()).andExpect(jsonPath("$[*].id", hasItem(id.intValue())));
        mvc.perform(get(${jstr(base + "/")} + id)${hdr}).andExpect(status().isOk());
        mvc.perform(put(${jstr(base + "/")} + id)${hdr}.contentType(MediaType.APPLICATION_JSON).content("${upd}"))
                .andExpect(status().isOk()).andExpect(${updExpect});
        mvc.perform(delete(${jstr(base + "/")} + id)${hdr}).andExpect(status().isNoContent());
        mvc.perform(get(${jstr(base + "/")} + id)${hdr}).andExpect(status().isNotFound());
    }

    @Test
    void validationErrorsUseTheStandardShape() throws Exception {
${A ? "        String auth = TestSupport.login(mvc, \"user\");\n" : ""}        mvc.perform(post(${jstr(base)})${hdr}.contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("validation_error"));
        mvc.perform(post(${jstr(base)})${hdr}.contentType(MediaType.APPLICATION_JSON).content("${payload.replace(/ }$/, ', \\"unexpected\\": 1 }')}"))
                .andExpect(status().isUnprocessableEntity());
        mvc.perform(get(${jstr(base)}).param("limit", "0")${hdr}).andExpect(status().isUnprocessableEntity());
    }
${A ? `
    @Test
    void requiresAuthAndIsIsolatedPerUser() throws Exception {
        mvc.perform(get(${jstr(base)})).andExpect(status().isUnauthorized());
        String one = TestSupport.login(mvc, "one");
        String created = mvc.perform(post(${jstr(base)}).header("Authorization", one).contentType(MediaType.APPLICATION_JSON).content("${payload}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        Number id = JsonPath.read(created, "$.id");
        String two = TestSupport.login(mvc, "two");
        mvc.perform(get(${jstr(base + "/")} + id).header("Authorization", two)).andExpect(status().isNotFound());
    }
` : ""}}
`;
  return files;
}

function generate(spec) {
  const A = spec.needsAuth;
  const f = {};
  const artifact = spec.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  f["pom.xml"] = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.5</version>
    <relativePath/>
  </parent>
  <groupId>app</groupId>
  <artifactId>${artifact}</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
    <dependency><groupId>io.micrometer</groupId><artifactId>micrometer-registry-prometheus</artifactId></dependency>
    <dependency><groupId>org.springdoc</groupId><artifactId>springdoc-openapi-starter-webmvc-api</artifactId><version>2.6.0</version></dependency>
    <dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId><scope>runtime</scope></dependency>
${A ? `    <dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-crypto</artifactId></dependency>
    <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-api</artifactId><version>0.12.6</version></dependency>
    <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-impl</artifactId><version>0.12.6</version><scope>runtime</scope></dependency>
    <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt-jackson</artifactId><version>0.12.6</version><scope>runtime</scope></dependency>
` : ""}    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>
`;
  f["src/main/resources/application.properties"] = `server.port=\${PORT:8080}
spring.datasource.url=\${DATABASE_URL:jdbc:h2:file:./data/app;AUTO_SERVER=TRUE}
spring.datasource.username=\${DATABASE_USERNAME:sa}
spring.datasource.password=\${DATABASE_PASSWORD:}
# Schema is created/updated at startup (no migrations): fine for development, use Flyway/Liquibase for production.
spring.jpa.hibernate.ddl-auto=update
spring.jpa.open-in-view=false
spring.jpa.properties.hibernate.globally_quoted_identifiers=true
spring.jackson.deserialization.fail-on-unknown-properties=true
spring.mvc.problemdetails.enabled=false
${A ? "app.jwt.secret=${JWT_SECRET:}\napp.jwt.ttl-seconds=3600\n" : ""}springdoc.api-docs.path=/openapi.json
springdoc.swagger-ui.enabled=false
# Prometheus text at /metrics (Micrometer). Counters are per instance.
management.endpoints.web.base-path=/
management.endpoints.web.exposure.include=prometheus
management.endpoints.web.path-mapping.prometheus=metrics
`;
  f["src/main/java/app/Application.java"] = `package app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;
  f["src/main/java/app/common/ApiException.java"] = `package app.common;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
    public final HttpStatus status;
    public final String code;
    public final Object details;

    public ApiException(HttpStatus status, String code, String message, Object details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }

    public static ApiException notFound(String what) { return new ApiException(HttpStatus.NOT_FOUND, "not_found", what + " not found", null); }
    public static ApiException conflict(String msg) { return new ApiException(HttpStatus.CONFLICT, "conflict", msg, null); }
    public static ApiException unauthorized(String msg) { return new ApiException(HttpStatus.UNAUTHORIZED, "unauthorized", msg, null); }
    public static ApiException validation(String loc, String msg) {
        return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "validation_error", "Request validation failed", List.of(Map.of("loc", loc, "msg", msg)));
    }
}
`;
  f["src/main/java/app/common/ApiExceptionHandler.java"] = `package app.common;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Every error leaves the API as {"error": {"code", "message", "details"}}. */
@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    private static ResponseEntity<Map<String, Object>> body(HttpStatus status, String code, String message, Object details) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code);
        err.put("message", message);
        err.put("details", details);
        return ResponseEntity.status(status).body(Map.of("error", err));
    }

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, Object>> api(ApiException e) { return body(e.status, e.code, e.getMessage(), e.details); }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<Map<String, Object>> invalid(MethodArgumentNotValidException e) {
        List<Map<String, String>> details = e.getBindingResult().getFieldErrors().stream()
                .map(fe -> Map.of("loc", fe.getField(), "msg", String.valueOf(fe.getDefaultMessage()))).toList();
        return body(HttpStatus.UNPROCESSABLE_ENTITY, "validation_error", "Request validation failed", details);
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<Map<String, Object>> unreadable(Exception e) {
        return body(HttpStatus.UNPROCESSABLE_ENTITY, "validation_error", "Request validation failed", List.of(Map.of("msg", "invalid request")));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<Map<String, Object>> noRoute(NoResourceFoundException e) { return body(HttpStatus.NOT_FOUND, "http_error", "Route not found", null); }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<Map<String, Object>> method(HttpRequestMethodNotSupportedException e) { return body(HttpStatus.METHOD_NOT_ALLOWED, "http_error", "Method not allowed", null); }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Map<String, Object>> unexpected(Exception e) {
        log.error("unhandled error", e);
        return body(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "Internal server error", null);
    }
}
`;
  f["src/main/java/app/common/OffsetLimit.java"] = `package app.common;

import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

/** Offset/limit paging for Spring Data (the framework's own Pageable is page-number based). */
public class OffsetLimit implements Pageable {
    private final long offset;
    private final int limit;
    private final Sort sort;

    public OffsetLimit(long offset, int limit, Sort sort) {
        this.offset = offset;
        this.limit = limit;
        this.sort = sort;
    }

    @Override public int getPageNumber() { return (int) (offset / limit); }
    @Override public int getPageSize() { return limit; }
    @Override public long getOffset() { return offset; }
    @Override public Sort getSort() { return sort; }
    @Override public Pageable next() { return new OffsetLimit(offset + limit, limit, sort); }
    @Override public Pageable previousOrFirst() { return new OffsetLimit(Math.max(0, offset - limit), limit, sort); }
    @Override public Pageable first() { return new OffsetLimit(0, limit, sort); }
    @Override public Pageable withPage(int pageNumber) { return new OffsetLimit((long) pageNumber * limit, limit, sort); }
    @Override public boolean hasPrevious() { return offset > 0; }
}
`;
  f["src/main/java/app/HealthController.java"] = `package app;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
`;
  if (A) {
    f["src/main/java/app/auth/User.java"] = `package app.auth;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(nullable = false, unique = true)
    public String email;

    @Column(nullable = false)
    public String name = "";

    @JsonIgnore
    @Column(name = "password_hash", nullable = false)
    public String passwordHash;

    @JsonProperty("created_at")
    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}
`;
    f["src/main/java/app/auth/UserRepository.java"] = `package app.auth;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
}
`;
    f["src/main/java/app/auth/AuthRequests.java"] = `package app.auth;

import jakarta.validation.constraints.*;

public class AuthRequests {
    public static class Register {
        @NotBlank @Email @Size(max = 255)
        public String email;
        @Size(max = 255)
        public String name;
        @NotNull @Size(min = 8, max = 72)
        public String password;
    }

    public static class Login {
        @NotBlank
        public String email;
        @NotBlank
        public String password;
    }
}
`;
    f["src/main/java/app/auth/JwtService.java"] = `package app.auth;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import javax.crypto.SecretKey;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/** HS256 tokens. The secret must come from the environment (JWT_SECRET) and be at least 32 bytes. */
@Service
public class JwtService {
    private final SecretKey key;
    private final long ttlSeconds;

    public JwtService(@Value("\${app.jwt.secret:}") String secret, @Value("\${app.jwt.ttl-seconds:3600}") long ttlSeconds) {
        if (secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("JWT_SECRET must be set to at least 32 characters");
        }
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.ttlSeconds = ttlSeconds;
    }

    public String issue(Long userId) {
        Date now = new Date();
        return Jwts.builder().subject(String.valueOf(userId)).issuedAt(now)
                .expiration(new Date(now.getTime() + ttlSeconds * 1000)).signWith(key).compact();
    }

    /** @return the user id, or null when the token is missing, malformed, expired or badly signed */
    public Long verify(String token) {
        try {
            return Long.valueOf(Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload().getSubject());
        } catch (Exception e) {
            return null;
        }
    }
}
`;
    f["src/main/java/app/auth/AuthInterceptor.java"] = `package app.auth;

import app.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/** Requires a valid bearer token for every /api route except register and login (see WebConfig). */
@Component
public class AuthInterceptor implements HandlerInterceptor {
    private final JwtService jwt;
    private final UserRepository users;

    public AuthInterceptor(JwtService jwt, UserRepository users) {
        this.jwt = jwt;
        this.users = users;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        if ("OPTIONS".equals(req.getMethod())) return true;
        String header = req.getHeader("Authorization");
        Long id = header != null && header.startsWith("Bearer ") ? jwt.verify(header.substring(7)) : null;
        if (id == null || !users.existsById(id)) throw ApiException.unauthorized("Invalid or missing credentials");
        req.setAttribute("uid", id);
        return true;
    }
}
`;
    f["src/main/java/app/auth/WebConfig.java"] = `package app.auth;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {
    private final AuthInterceptor interceptor;

    public WebConfig(AuthInterceptor interceptor) {
        this.interceptor = interceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(interceptor).addPathPatterns("/api/**").excludePathPatterns("/api/auth/register", "/api/auth/login");
    }
}
`;
    f["src/main/java/app/auth/AuthController.java"] = `package app.auth;

import app.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final UserRepository users;
    private final JwtService jwt;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthController(UserRepository users, JwtService jwt) {
        this.users = users;
        this.jwt = jwt;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public User register(@Valid @RequestBody AuthRequests.Register in) {
        String email = in.email.trim().toLowerCase();
        if (users.findByEmail(email).isPresent()) throw ApiException.conflict("Email already registered");
        User u = new User();
        u.email = email;
        u.name = in.name == null ? "" : in.name;
        u.passwordHash = encoder.encode(in.password);
        return users.save(u);
    }

    @PostMapping("/login")
    public Map<String, String> login(@Valid @RequestBody AuthRequests.Login in) {
        User u = users.findByEmail(in.email.trim().toLowerCase()).orElse(null);
        if (u == null || !encoder.matches(in.password, u.passwordHash)) throw ApiException.unauthorized("Invalid email or password");
        return Map.of("access_token", jwt.issue(u.id), "token_type", "bearer");
    }

    @GetMapping("/me")
    public User me(HttpServletRequest req) {
        return users.findById((Long) req.getAttribute("uid")).orElseThrow(() -> ApiException.unauthorized("Invalid or missing credentials"));
    }
}
`;
  }
  const tokenProp = A ? '"app.jwt.secret=test-secret-not-for-production-0123456789"' : '"app.name=test"';
  f["src/test/java/app/TestSupport.java"] = `package app;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.jayway.jsonpath.JsonPath;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

public final class TestSupport {
    private TestSupport() {}

    /** Registers a fresh user and returns the Authorization header value. */
    public static String login(MockMvc mvc, String label) throws Exception {
        String email = label + "-" + UUID.randomUUID() + "@example.com";
        String body = "{\\"email\\": \\"" + email + "\\", \\"password\\": \\"password123\\"}";
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(body));
        String res = mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content(body)).andReturn().getResponse().getContentAsString();
        return "Bearer " + JsonPath.read(res, "$.access_token");
    }
}
`;
  f["src/test/java/app/PlatformTest.java"] = `package app;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = ${tokenProp})
@AutoConfigureMockMvc
class PlatformTest {
    @Autowired MockMvc mvc;

    @Test
    void health() throws Exception {
        mvc.perform(get("/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"));
    }

    @Test
    void openApiIsServed() throws Exception {
        mvc.perform(get("/openapi.json")).andExpect(status().isOk()).andExpect(jsonPath("$.openapi").exists()).andExpect(jsonPath("$.paths['/health']").exists());
    }

    @Test
    void metricsExposePrometheusText() throws Exception {
        mvc.perform(get("/health"));
        mvc.perform(get("/metrics")).andExpect(status().isOk()).andExpect(content().string(org.hamcrest.Matchers.containsString("http_server_requests")));
    }

    @Test
    void unknownRouteUsesTheStandardShape() throws Exception {
        mvc.perform(get("/nope")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("http_error"));
    }
}
`;
  if (A) f["src/test/java/app/AuthTest.java"] = `package app;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = ${tokenProp})
@AutoConfigureMockMvc
class AuthTest {
    @Autowired MockMvc mvc;

    private static String json(String email, String password) {
        return "{\\"email\\": \\"" + email + "\\", \\"password\\": \\"" + password + "\\"}";
    }

    @Test
    void registerLoginMeAndNoPasswordLeak() throws Exception {
        String body = mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(json("a@example.com", "password123")))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        org.junit.jupiter.api.Assertions.assertFalse(body.contains("password"));
        String login = mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content(json("a@example.com", "password123")))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        String token = JsonPath.read(login, "$.access_token");
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token)).andExpect(status().isOk()).andExpect(jsonPath("$.email").value("a@example.com"));
    }

    @Test
    void duplicateWeakPasswordBadLoginBadToken() throws Exception {
        String ok = json("d@example.com", "password123");
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(ok)).andExpect(status().isCreated());
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(ok)).andExpect(status().isConflict());
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(json("w@example.com", "short")))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("validation_error"));
        mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content(json("d@example.com", "wrong-password"))).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer nope")).andExpect(status().isUnauthorized());
    }
}
`;
  for (const e of spec.entities) Object.assign(f, entityFiles(spec, e));
  f[".env.example"] = ["PORT=8080", "DATABASE_URL=jdbc:h2:file:./data/app;AUTO_SERVER=TRUE", ...(A ? ["JWT_SECRET=changeme_use_a_long_random_secret_of_32_chars_or_more"] : [])].join("\n") + "\n";
  f["Dockerfile"] = `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --uid 10001 app && mkdir -p /app/data && chown app /app/data
COPY --from=build /src/target/*.jar app.jar
USER app
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["sh", "-c", "wget -qO- http://127.0.0.1:$PORT/health >/dev/null || exit 1"]
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
  f["docker-compose.yml"] = `services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
${A ? "      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET (32+ chars) in your shell or .env}\n" : ""}      DATABASE_URL: jdbc:h2:file:/app/data/app;AUTO_SERVER=TRUE
    volumes:
      - appdata:/app/data
volumes:
  appdata:
`;
  f[".dockerignore"] = "target\ndata\n.env\n";
  f[".gitignore"] = "target/\ndata/\n.env\n";
  f["README.md"] = `# ${spec.name}

Spring Boot 3 (Java 21) backend generated by Sierra. Layers: \`controller -> service -> repository\` (Spring Data JPA), Bean Validation DTOs, H2 by default.

## Run
\`\`\`
${A ? "export JWT_SECRET=$(openssl rand -hex 32)\n" : ""}mvn spring-boot:run
\`\`\`
Requires JDK 21 and Maven. OpenAPI: \`GET /openapi.json\` (springdoc). Metrics: \`GET /metrics\` (Micrometer, Prometheus text).

## Test
\`\`\`
mvn test
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\`
${A ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/{id}\``).join("\n")}

## Known limitations
- **Not compiled by Sierra when this project was generated.** Sierra could not download Maven dependencies in its build environment, so these tests were never run there. Run \`mvn test\` yourself before relying on it.
- H2 is the default database (embedded file). To use PostgreSQL, add its JDBC driver to the pom and set \`DATABASE_URL\`, \`DATABASE_USERNAME\`, \`DATABASE_PASSWORD\`.
- Schema is managed by Hibernate \`ddl-auto=update\`; there are no migrations.
- BCrypt + HS256 JWT; no refresh tokens or rate limiting. Auth is a HandlerInterceptor, not Spring Security: there is no CSRF/CORS/header hardening beyond what Spring MVC gives by default.
`;
  return f;
}

module.exports = {
  id: "spring-boot",
  label: "Spring Boot",
  language: "Java",
  framework: "Spring Boot",
  status: "implemented",
  databases: ["h2"],
  notes: "Java 21 + Maven, H2 by default. Not compiled by Sierra in an offline environment.",
  generate,
  validate: {
    toolchain: "mvn",
    setup: [["mvn", "-B", "-q", "-DskipTests", "test-compile"]],
    test: [["mvn", "-B", "-q", "test"]],
    offlineMeansSkipped: true,
  },
};
