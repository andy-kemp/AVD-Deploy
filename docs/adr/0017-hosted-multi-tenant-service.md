# ADR 0017: Hosted multi-tenant service

Status: Proposed. Date: 2026-10-16. Supersedes [ADR 0001](0001-self-hosted-distribution.md) for the hosted offering.

## Context

ADR 0001 made every customer install the portal into their own subscription and tenant. That keeps privileged access with the customer but makes each customer run a bootstrap, own app registrations and operate Static Web Apps, an API, workers and storage before they can deploy a single host. The goal is now a service that Andy Kemp Consulting (AKC) runs, where a customer signs up, connects their tenant and builds their own AVD estate without installing anything.

## Decision

AKC hosts one control plane in AKC's Azure subscription and Entra tenant. Customers never install it.

- **The control plane is AKC's.** Portal, API, job queue, plan and job state, worker containers and monitoring run in AKC's subscription.
- **Workloads are the customer's.** Every AVD resource (resource group, network, Key Vault, host pool, storage, session hosts) is created in the customer's own subscription and is billed to them. AKC stores no customer secrets: the generated local admin password stays in the customer's Key Vault, as today.
- **One multi-tenant Entra application** (the "AKC AVD Deploy" app, registered in AKC's tenant) is the only thing that appears in a customer tenant. Customers connect by consenting to it ([ADR 0018](0018-accounts-and-tenant-connection.md)).
- **Execution reaches the customer tenant through that app** with narrowly scoped, customer-granted access ([ADR 0019](0019-cross-tenant-execution.md)).
- **Tenant isolation is a hard rule.** Every stored record carries the customer organisation ID and Entra tenant ID. Every API request and every worker job checks both before touching Azure or Graph.
- **Azure hosting, andykemp.com domain.** Everything runs in Azure (not Cloudflare). The front end is an Azure Static Web App (Standard) on `avd-deploy.andykemp.com`, with the API on Azure Container Apps linked as its backend, as in [ADR 0004](0004-hosting-and-workers.md). The andykemp.com DNS zone (Cloudflare) only gets a `CNAME` straight to the Static Web App; it must be DNS-only (not proxied), because the managed certificate doesn't validate or renew behind a proxy. This does not reopen [ADR 0007](0007-no-cloudflare.md): no Cloudflare hosting or edge services.
- **The engine stays the same.** The existing PowerShell modules, contract and Bicep remain the deployment engine. The CLI keeps working for anyone who wants to run it themselves; self-hosting stays possible but is no longer the primary product.

## Consequences

- AKC holds standing reach into every connected tenant, bounded by what each customer granted. The threat model gains cross-tenant threats (T22 onwards) and AKC needs incident response, audit retention and an offboarding process.
- Customers do not need Entra ID P1/P2 for portal role assignment, because portal roles move to the account system.
- Customers still need an administrator for the one-off consent and the Azure role grants during onboarding. That cannot be removed by any design.
- Data residency: control-plane data (configurations, plans, job history, sanitised logs) lives in AKC's chosen region, UK South by default. Workload data stays in the customer's chosen region.
- Pricing, terms of service and a data processing agreement become prerequisites for a public launch.

## Alternatives considered

- **Keep self-hosted only (ADR 0001).** Strongest isolation, but the install burden defeats self-service.
- **Azure Lighthouse.** Designed for managed service providers acting on customer subscriptions. It covers Azure resources only, not the Graph steps (group lookup, RDP Entra authentication, storage app consent, Conditional Access), so a multi-tenant app is needed anyway.
- **One app registration per customer.** Avoids a shared multi-tenant app but brings back per-customer bootstrap and secret management.
