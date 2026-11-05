import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { openGraphStore, refreshGraph } from "../src/graph/build.js";
import { extractJava } from "../src/graph/java-extract.js";
import { pathSegments } from "../src/graph/java-resolve.js";
import { graphSections } from "../src/graph/map-sections.js";
import { formatContext, formatImpact, formatPath, resolveTarget } from "../src/graph/query.js";
import { graphContext, graphIndex, graphPath } from "../src/graph/tools.js";
import type { GraphNode, GraphStore } from "../src/graph/types.js";
import type { Chat } from "../src/llm.js";
import { mapCodebase } from "../src/pipeline.js";

const ORDERS = "orders/src/main/java/com/acme/orders";
const USERS = "users/src/main/java/com/acme/users";

const FIXTURE: Record<string, string> = {
  "orders/pom.xml": "<project/>",
  "users/pom.xml": "<project/>",
  [`${ORDERS}/controllers/OrderController.java`]: `
package com.acme.orders.controllers;
import com.acme.orders.services.OrderService;
import com.acme.orders.models.OrderModel;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderService orderService;
  public OrderController(OrderService orderService) { this.orderService = orderService; }
  @GetMapping("/{id}")
  public OrderModel get(@PathVariable String id) { return orderService.find(id); }
  @PostMapping
  public void create(@RequestBody OrderModel order) { orderService.save(order); }
}`,
  [`${ORDERS}/services/OrderService.java`]: `
package com.acme.orders.services;
import com.acme.orders.models.OrderModel;
public interface OrderService {
  OrderModel find(String id);
  void save(OrderModel order);
}`,
  [`${ORDERS}/services/OrderServiceImpl.java`]: `
package com.acme.orders.services;
import com.acme.orders.clients.UserClient;
import com.acme.orders.models.OrderModel;
import com.acme.orders.repositories.OrderRepository;
import org.springframework.stereotype.Service;
@Service
public class OrderServiceImpl implements OrderService {
  @Autowired OrderRepository repository;
  @Autowired UserClient userClient;
  @Override public OrderModel find(String id) { return repository.findById(id).get(); }
  @Override public void save(OrderModel order) { userClient.getUser(order.getId()); audit(); repository.save(order); }
  private void audit() {}
}`,
  [`${ORDERS}/services/OtherOrderService.java`]: `
package com.acme.orders.services;
import com.acme.orders.models.OrderModel;
public class OtherOrderService implements OrderService {
  public OrderModel find(String id) { return null; }
  public void save(OrderModel order) {}
}`,
  [`${ORDERS}/repositories/OrderRepository.java`]: `
package com.acme.orders.repositories;
import com.acme.orders.models.OrderModel;
public interface OrderRepository extends JpaRepository<OrderModel, String> {}`,
  [`${ORDERS}/models/OrderModel.java`]: `
package com.acme.orders.models;
@Entity
@Table(name = "TB_ORDERS")
public class OrderModel {
  private String id;
  public String getId() { return id; }
}`,
  [`${ORDERS}/clients/UserClient.java`]: `
package com.acme.orders.clients;
import org.springframework.web.client.RestTemplate;
@Component
public class UserClient {
  @Autowired RestTemplate restTemplate;
  @Value("\${services.users.url}") String baseUrl;
  public String getUser(String id) {
    String url = baseUrl.concat("/users/").concat(id);
    return restTemplate.exchange(url, HttpMethod.GET, null, String.class).getBody();
  }
  public void removeUser(String id) {
    restTemplate.delete(baseUrl + "/users/" + id);
  }
  public void dynamic(String built) {
    restTemplate.getForObject(built, String.class);
  }
}`,
  // A package whose name is also a default noise directory. It must not disappear.
  [`${USERS}/vendor/VendorInfo.java`]: `
package com.acme.users.vendor;
public class VendorInfo {}`,
  [`${USERS}/controllers/UserController.java`]: `
package com.acme.users.controllers;
import com.acme.users.vendor.VendorInfo;
@RestController
@RequestMapping(value = "/users")
public class UserController {
  @GetMapping("/{userId}")
  public String one(@PathVariable String userId) { return new VendorInfo().toString(); }
  @DeleteMapping("/{userId}")
  public void remove(@PathVariable String userId) {}
  @GetMapping("/courses/{courseId}")
  public String byCourse(@PathVariable String courseId) { return ""; }
}`,
  "orders/src/test/java/com/acme/orders/services/OrderServiceImplTest.java": `
package com.acme.orders.services;
class OrderServiceImplTest {
  OrderServiceImpl service = new OrderServiceImpl();
  void saves() { service.save(null); }
}`,
  ".env": "SECRET_VALUE=do-not-read\n",
};

let root: string;
let store: GraphStore;

before(async () => {
  root = await project(FIXTURE);
  store = await openGraphStore(root);
  await refreshGraph(root, store);
});

after(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const extraRoots: string[] = [];
afterEach(async () => {
  for (const extra of extraRoots.splice(0)) await rm(extra, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "project-mapper-graph-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return directory;
}

function node(target: string): GraphNode {
  const resolution = resolveTarget(store, target);
  assert.ok("found" in resolution, `could not resolve ${target}: ${"error" in resolution ? resolution.error : ""}`);
  return resolution.found;
}

function edgeTargets(from: string, kind: Parameters<GraphStore["edges"]>[2] extends (infer K)[] | undefined ? K : never): string[] {
  return store
    .nodes(store.edges([node(from).id], "out", [kind]).map((edge) => edge.to))
    .map((other) => other.qualifiedName)
    .sort();
}

test("extracts structure from every kind of Java type", async () => {
  const facts = await extractJava(`
    package a.b;
    import static x.Y.foo;
    import c.d.*;
    import e.F;
    public class C<T> extends B<T> implements I, J {
      class Inner {}
      int m(String a, int... b) { var x = new X(); return 1; }
    }
    interface I extends K { void z(); }
    enum En implements I { A; void g() {} }
    record R(int a, D b) implements I {}
    @interface An { String v(); }`);
  assert.equal(facts.packageName, "a.b");
  assert.deepEqual(facts.imports, [
    { name: "x.Y.foo", isStatic: true, isWildcard: false },
    { name: "c.d", isStatic: false, isWildcard: true },
    { name: "e.F", isStatic: false, isWildcard: false },
  ]);
  assert.deepEqual(
    facts.types.map((type) => [type.localName, type.kind]),
    [["C", "class"], ["C.Inner", "class"], ["I", "interface"], ["En", "enum"], ["R", "record"], ["An", "annotation"]],
  );
  const c = facts.types[0];
  assert.deepEqual(c?.superTypes.map((type) => [type.name, type.relation]), [["B", "extends"], ["I", "implements"], ["J", "implements"]]);
  const method = c?.methods[0];
  assert.equal(method?.arity, 2);
  assert.deepEqual(method?.locals, { a: "String", b: "int", x: "X" });
  assert.equal(facts.types[4]?.fields.map((field) => field.name).join(), "a,b");
  assert.equal(facts.hasParseErrors, false);
});

test("reports files the parser could not fully understand", async () => {
  assert.equal((await extractJava("class {{{")).hasParseErrors, true);
});

test("pathSegments reads the path out of a URL template", () => {
  assert.deepEqual(pathSegments("${base}/users/{}/courses?x=1"), ["users", "*", "courses"]);
  assert.deepEqual(pathSegments("http://svc:8080/a/{id}"), ["a", "*"]);
  assert.equal(pathSegments("{}"), null);
});

test("does not lose a package named like a noise directory, nor read secrets", async () => {
  assert.equal(node("VendorInfo").kind, "type");
  assert.ok(!JSON.stringify(store.snapshot()).includes("do-not-read"));
  assert.ok((await graphIndex(root)).includes("already up to date"));
});

test("resolves inheritance, injection and repository-to-entity links", () => {
  assert.deepEqual(edgeTargets("OrderServiceImpl", "implements"), ["com.acme.orders.services.OrderService"]);
  assert.deepEqual(edgeTargets("OrderController", "injects"), ["com.acme.orders.services.OrderService"]);
  assert.deepEqual(edgeTargets("OrderServiceImpl", "injects"), [
    "com.acme.orders.clients.UserClient",
    "com.acme.orders.repositories.OrderRepository",
  ]);
  assert.ok(edgeTargets("OrderRepository", "uses").includes("com.acme.orders.models.OrderModel"));
  assert.deepEqual(edgeTargets("OrderModel", "maps_to"), ["TB_ORDERS"]);
});

test("resolves calls through fields, this, and to methods inherited from outside the project", () => {
  assert.deepEqual(edgeTargets("OrderController#get/1", "calls"), ["com.acme.orders.services.OrderService#find/1"]);
  const save = edgeTargets("OrderServiceImpl#save/1", "calls");
  assert.ok(save.includes("com.acme.orders.clients.UserClient#getUser/1"));
  assert.ok(save.includes("com.acme.orders.services.OrderServiceImpl#audit/0"));
  assert.ok(edgeTargets("OrderServiceImpl#find/1", "uses").includes("com.acme.orders.repositories.OrderRepository"));
  assert.deepEqual(edgeTargets("OrderServiceImpl#find/1", "overrides"), ["com.acme.orders.services.OrderService#find/1"]);
});

test("builds endpoints from class and method mappings, in the right module", () => {
  const endpoints = store.search("/", { kind: "endpoint", limit: 50 }).map((endpoint) => endpoint.qualifiedName).sort();
  assert.deepEqual(endpoints, [
    "orders:GET /orders/{id}",
    "orders:POST /orders",
    "users:DELETE /users/{userId}",
    "users:GET /users/courses/{courseId}",
    "users:GET /users/{userId}",
  ]);
  assert.deepEqual(edgeTargets("orders:GET /orders/{id}", "handled_by"), ["com.acme.orders.controllers.OrderController#get/1"]);
});

test("links REST client calls to the endpoint they reach in another service", () => {
  assert.deepEqual(edgeTargets("UserClient#getUser/1", "http_calls"), ["users:GET /users/{userId}"]);
  assert.deepEqual(edgeTargets("UserClient#removeUser/1", "http_calls"), ["users:DELETE /users/{userId}"]);
});

test("records a call whose URL is only known at runtime as unresolved, not as a guess", () => {
  assert.deepEqual(edgeTargets("UserClient#dynamic/1", "http_calls"), []);
  assert.deepEqual(node("UserClient#dynamic/1").unresolvedHttp, ["GET {}"]);
  assert.equal(store.stats().unresolvedHttpCalls, 1);
});

test("a password in a literal URL does not reach the graph", async () => {
  const directory = await project({
    "src/main/java/x/Client.java": `package x;
      public class Client {
        RestTemplate restTemplate;
        void call() { restTemplate.getForObject("http://admin:hunter2@legacy.internal/thing", String.class); }
      }`,
  });
  extraRoots.push(directory);
  const graph = await openGraphStore(directory);
  try {
    await refreshGraph(directory, graph);
    const [method] = graph.search("Client#call/0");
    assert.deepEqual(method?.unresolvedHttp, ["GET http://admin:[REDACTED]@legacy.internal/thing"]);
  } finally {
    graph.close();
  }
});

test("impact of an implementation reaches callers of its interface, endpoints and tests", () => {
  const report = formatImpact(store, node("OrderServiceImpl#save/1"), 3);
  assert.ok(report.includes("orders:POST /orders"), report);
  assert.ok(report.includes("OrderController#create/1"), report);
  assert.ok(report.includes("OrderServiceImplTest#saves/0"), report);
  assert.ok(!report.includes("orders:GET /orders/{id}"), "a different method must not be affected");
  assert.ok(!report.includes("OtherOrderService"), "a sibling implementation must not be affected");
});

test("impact crosses services over HTTP", () => {
  const report = formatImpact(store, node("users:GET /users/{userId}"), 5);
  assert.ok(report.includes("UserClient#getUser/1"), report);
  assert.ok(report.includes("orders:POST /orders"), report);
});

test("impact of a table reaches the code that maps it", () => {
  const report = formatImpact(store, node("TB_ORDERS"), 1);
  assert.ok(report.includes("com.acme.orders.models.OrderModel"), report);
});

test("path follows the code across interface dispatch and HTTP", () => {
  const report = formatPath(store, node("OrderController#create/1"), node("UserController#one/1"));
  const expected = ["OrderService#save/1", "OrderServiceImpl#save/1", "UserClient#getUser/1", "users:GET /users/{userId}", "UserController#one/1"];
  let position = -1;
  for (const step of expected) {
    const next = report.indexOf(step, position + 1);
    assert.ok(next > position, `${step} missing or out of order:\n${report}`);
    position = next;
  }
  assert.ok(report.includes("dispatches_to"), report);
});

test("path to a class ends at whichever of its members is reached first", () => {
  const report = formatPath(store, node("OrderController#create/1"), node("UserController"));
  assert.ok(report.includes("users:GET /users/{userId}"), report);
  assert.ok(report.includes("UserController#one/1"), report);
  assert.ok(!report.startsWith("No dependency path"), report);
});

test("path from a class starts at any of its members, and also works in reverse", () => {
  assert.ok(formatPath(store, node("OrderController"), node("OrderModel")).includes("OrderController"));
  const reverse = formatPath(store, node("UserController#one/1"), node("OrderController#create/1"));
  assert.ok(reverse.includes("depends on"), reverse);
});

test("path says so when nothing connects two nodes", () => {
  assert.ok(formatPath(store, node("VendorInfo"), node("OrderModel")).startsWith("No dependency path"));
});

test("targets can be written in several ways, and ambiguity is explained", () => {
  assert.equal(node("OrderServiceImpl.save").qualifiedName, "com.acme.orders.services.OrderServiceImpl#save/1");
  assert.equal(node(`${ORDERS}/models/OrderModel.java`).kind, "file");
  assert.equal(node("POST /orders").kind, "endpoint");
  const ambiguous = resolveTarget(store, "save");
  assert.ok("error" in ambiguous && ambiguous.error.includes("ambiguous"));
  const missing = resolveTarget(store, "DoesNotExist");
  assert.ok("error" in missing && missing.error.includes("graph_search"));
});

test("context shows both directions", () => {
  const report = formatContext(store, node("OrderService#save/1"));
  assert.ok(report.includes("Called by"), report);
  assert.ok(report.includes("OrderController#create/1"), report);
  assert.ok(report.includes("Overridden by"), report);
});

test("a change is picked up by the next query, parsing only the changed file", async () => {
  const directory = await project(FIXTURE);
  extraRoots.push(directory);
  const graph = await openGraphStore(directory);
  try {
    assert.equal((await refreshGraph(directory, graph)).parsedFiles, 10);
    assert.equal((await refreshGraph(directory, graph)).rebuilt, false);

    await writeFile(
      join(directory, `${USERS}/vendor/VendorInfo.java`),
      "package com.acme.users.vendor;\npublic class VendorInfo { void added() {} }",
    );
    const update = await refreshGraph(directory, graph);
    assert.equal(update.rebuilt, true);
    assert.equal(update.parsedFiles, 1);
    assert.equal(graph.search("VendorInfo#added/0").length, 1);

    assert.equal((await refreshGraph(directory, graph, { force: true })).parsedFiles, 10);
  } finally {
    graph.close();
  }
  assert.ok((await graphContext("VendorInfo#added", directory)).includes("VendorInfo.java"));
});

test("identical class names in two services stay separate", async () => {
  const directory = await project({
    "a/pom.xml": "<project/>",
    "b/pom.xml": "<project/>",
    "a/src/main/java/x/Dto.java": "package x; public class Dto {}",
    "a/src/main/java/x/Svc.java": "package x; public class Svc { Dto d; }",
    "b/src/main/java/x/Dto.java": "package x; public class Dto {}",
    "b/src/main/java/x/Svc.java": "package x; public class Svc { Dto d; }",
  });
  extraRoots.push(directory);
  const graph = await openGraphStore(directory);
  try {
    await refreshGraph(directory, graph);
    assert.equal(graph.search("x.Dto").length, 2);
    const fromA = graph.edges(["type:a:x.Svc"], "out", ["uses"]).map((edge) => edge.to);
    assert.deepEqual(fromA, ["type:a:x.Dto"]);
  } finally {
    graph.close();
  }
});

test("a repository with no Java says so, instead of an empty answer", async () => {
  const directory = await project({ "a.ts": "export {};" });
  extraRoots.push(directory);
  assert.ok((await graphIndex(directory)).includes("only Java"));
  assert.ok((await graphPath("a", "b", directory)).includes("only Java"));
});

test("a damaged graph file is rebuilt, since it holds nothing original", async () => {
  const directory = await project(FIXTURE);
  extraRoots.push(directory);
  await mkdir(join(directory, ".project-mapper"), { recursive: true });
  await writeFile(join(directory, ".project-mapper/graph.sqlite"), "this is not a database, not at all");
  assert.ok((await graphIndex(directory)).includes("Graph rebuilt"));
});

test("graph sections show services and endpoints without any model", () => {
  const sections = graphSections(store.snapshot());
  assert.ok(sections);
  assert.ok(sections.markdown.includes("## Service Dependencies"));
  assert.ok(sections.markdown.includes('m_orders -->|"2 HTTP"| m_users'), sections.markdown);
  assert.ok(sections.markdown.includes("`POST /orders`"));
  assert.ok(sections.facts.includes("Database tables: TB_ORDERS"));
  assert.ok(sections.facts.includes("HTTP call: com.acme.orders.clients.UserClient#getUser/1 -> users:GET /users/{userId}"));
});

test("the map carries the graph sections and gives the model the graph facts", async () => {
  const directory = await project(FIXTURE);
  extraRoots.push(directory);
  const seen: string[] = [];
  const chat: Chat = async (request) => {
    seen.push(request.user);
    if (request.system.includes("system-level sections")) {
      return { text: "<agents_summary>Summary.</agents_summary>\n\n## System Overview\nOverview.", truncated: false };
    }
    return { text: "report", truncated: false };
  };
  const result = await mapCodebase(directory, { ...loadConfig({}), model: "fake" }, { chat });
  assert.equal(result.status, "mapped");

  const map = await readFile(join(directory, "docs/CODEBASE_MAP.md"), "utf8");
  assert.ok(map.includes("## HTTP Endpoints"));
  assert.ok(map.indexOf("## Service Dependencies") < map.indexOf("## Module Guide"));
  assert.ok(seen.at(-1)?.startsWith("<graph_facts>"));
  assert.ok((await readFile(join(directory, "AGENTS.md"), "utf8")).includes("graph_impact"));
});

test("a project without Java gets no graph sections", async () => {
  const directory = await project({ "src/a.ts": "export const a = 1;" });
  extraRoots.push(directory);
  const chat: Chat = async (request) => ({
    text: request.system.includes("system-level") ? "<agents_summary>S</agents_summary>" : "`src/a.ts`",
    truncated: false,
  });
  await mapCodebase(directory, { ...loadConfig({}), model: "fake" }, { chat });
  assert.ok(!(await readFile(join(directory, "docs/CODEBASE_MAP.md"), "utf8")).includes("## HTTP Endpoints"));
  assert.ok(!(await readFile(join(directory, "AGENTS.md"), "utf8")).includes("graph_impact"));
});
