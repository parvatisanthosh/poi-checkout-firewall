/**
 * Arena tenant management for the Bazaar (CONTRACTS-L2 section 4.5).
 *
 * Each tenant provides an isolated catalog for an arena trial:
 * the base scenario's 4 benign listings + this evolved product (sku "ARENA-<tenant>").
 * In-memory with a 2-hour TTL, plus persisted copy in data/arena/<tenant>.json.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BazaarProduct } from "@poi/shared";
import type { BazaarData, Product } from "../data";

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface TenantRecord {
  tenantId: string;
  product: BazaarProduct;
  baseScenario: string;
  terms?: string;
  createdAt: number;
  expiresAt: number;
}

const ARENA_DATA_DIR = fileURLToPath(new URL("../../data/arena/", import.meta.url));

class TenantStore {
  private tenants = new Map<string, TenantRecord>();

  constructor() {
    this.ensureDir();
  }

  private ensureDir() {
    if (!existsSync(ARENA_DATA_DIR)) {
      try {
        mkdirSync(ARENA_DATA_DIR, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  register(
    tenantId: string,
    rawProduct: BazaarProduct,
    baseScenario: string,
    _data?: BazaarData,
  ): { sku: string } {
    this.ensureDir();
    const now = Date.now();

    // Assign new sku "ARENA-<tenant>"
    const evolvedSku = `ARENA-${tenantId}`;
    const product = BazaarProduct.parse({
      ...rawProduct,
      sku: evolvedSku,
    });

    const record: TenantRecord = {
      tenantId,
      product,
      baseScenario,
      terms: product.termsExcerpt,
      createdAt: now,
      expiresAt: now + TTL_MS,
    };

    this.tenants.set(tenantId, record);

    // Persist JSON to data/arena/<tenant>.json
    try {
      const filePath = join(ARENA_DATA_DIR, `${tenantId}.json`);
      writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    } catch (e) {
      console.warn(`[arena-tenant] Failed to persist tenant ${tenantId}:`, (e as Error).message);
    }

    return { sku: product.sku };
  }

  delete(tenantId: string): { ok: boolean } {
    this.tenants.delete(tenantId);
    try {
      const path = join(ARENA_DATA_DIR, `${tenantId}.json`);
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {
      // ignore
    }
    return { ok: true };
  }

  get(tenantId: string): TenantRecord | null {
    const record = this.tenants.get(tenantId);
    const now = Date.now();
    if (record) {
      if (now > record.expiresAt) {
        this.delete(tenantId);
        return null;
      }
      return record;
    }

    // Try loading persisted file from data/arena/<tenant>.json
    try {
      const path = join(ARENA_DATA_DIR, `${tenantId}.json`);
      if (existsSync(path)) {
        const fileContent = JSON.parse(readFileSync(path, "utf8")) as TenantRecord;
        if (now <= fileContent.expiresAt || tenantId.includes("heldout")) {
          this.tenants.set(tenantId, fileContent);
          return fileContent;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  getCatalog(tenantId: string, data: BazaarData): Product[] | null {
    const tenant = this.get(tenantId);
    if (!tenant) return null;

    const s = data.scenario(tenant.baseScenario);
    // Base scenario's 4 benign listings
    const benignSkus = s ? s.acceptableSkus.slice(0, 4) : [];
    const benign = benignSkus.map((sku) => data.product(sku)).filter((p): p is Product => !!p);

    // Tenant catalog = baseScenario's 4 benign listings + this product
    return [...benign, tenant.product];
  }

  getProduct(tenantId: string, sku: string, data: BazaarData): Product | undefined {
    const tenant = this.get(tenantId);
    if (tenant && tenant.product.sku === sku) {
      return tenant.product;
    }
    return data.product(sku);
  }

  getTerms(tenantId: string | undefined, merchantId: string, data: BazaarData): string | undefined {
    if (tenantId) {
      const tenant = this.get(tenantId);
      if (
        tenant &&
        (tenant.product.merchantId === merchantId ||
          tenant.product.merchantId.replace(/^merchant-/, "") ===
            merchantId.replace(/^merchant-/, ""))
      ) {
        if (tenant.terms) return tenant.terms;
      }
    }

    return data.terms.get(merchantId);
  }
}

export const tenantStore = new TenantStore();
