# DESIGN ONLY, NEVER APPLIED. GCP production target for the transaction-dispute intake workflow
# (unrecognized card charges, human handoff), the counterpart of ../aws-target/architecture.yaml.
# It makes each sizing and security choice reviewable and renders the diagram in build_diagram.py.
# The live prototype runs on Cloudflare Workers + D1 (ADR-003). Prices: README.md in this folder,
# list prices from the Cloud Billing Catalog API, read 2026-10-04.
#
# Deployable with Infrastructure Manager or `terraform apply`, but nobody has, and `terraform validate`
# is the only check run. Sizing: ADR-004 section 3 (S2 in-scope episodes, S3 front-door contacts).

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = ">= 6.0" }
  }
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1" # the Vertex AI model below is served regionally here; South America isn't offered
}
variable "domain" { type = string }
variable "api_image" { type = string }   # Node 22 API container (the Worker's routes, store on PostgreSQL)
variable "batch_image" { type = string } # the same Python + DuckDB pipeline as data_pipelines/

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # The extractor's successor, served in-region so customer text never leaves us-central1 (ADR-012, plan).
  vertex_model = "gemini-2.5-flash-lite"
}

# ---------- Security: one customer-managed key for the database, the lake and the logs ----------
resource "google_kms_key_ring" "data" {
  name     = "arabica-data"
  location = var.region
}

resource "google_kms_crypto_key" "data" {
  name            = "arabica-data"
  key_ring        = google_kms_key_ring.data.id
  rotation_period = "7776000s" # 90 days
  lifecycle { prevent_destroy = true }
}

# ---------- Network: private database, no NAT, Google APIs through Private Google Access ----------
resource "google_compute_network" "vpc" {
  name                    = "arabica"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "private" {
  name                     = "arabica-private"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true # Vertex AI, Cloud SQL Admin and Logging without a NAT gateway
}

resource "google_compute_global_address" "sql_range" {
  name          = "arabica-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_range.name]
}

# ---------- Data: Cloud SQL for PostgreSQL, regional (HA across two zones) ----------
resource "google_sql_database_instance" "intake" {
  name                = "arabica-intake"
  database_version    = "POSTGRES_16"
  region              = var.region
  encryption_key_name = google_kms_crypto_key.data.id
  deletion_protection = true
  depends_on          = [google_service_networking_connection.sql]

  settings {
    tier              = "db-g1-small" # shared core, 1.7 GB: sized for availability and memory, not CPU (README)
    availability_type = "REGIONAL"    # standby in a second zone; an accepted case survives a zone failure
    disk_type         = "PD_SSD"
    disk_size         = 20
    ip_configuration {
      ipv4_enabled    = false # private IP only
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings { retained_backups = 7 }
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on" # the API signs in as its service account; no database password exists
    }
  }
}

resource "google_sql_database" "intake" {
  name     = "intake"
  instance = google_sql_database_instance.intake.name
}

# ---------- Identities: one service account per workload, least privilege ----------
resource "google_service_account" "api" {
  account_id   = "arabica-api"
  display_name = "Intake API (Cloud Run)"
}

resource "google_service_account" "batch" {
  account_id   = "arabica-batch"
  display_name = "Daily Bronze-Silver-Gold batch (Cloud Run job)"
}

resource "google_project_iam_member" "api_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
    "roles/aiplatform.user", # Vertex AI predictions only
    "roles/cloudtasks.enqueuer",
    "roles/logging.logWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "batch_roles" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser", "roles/logging.logWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.batch.email}"
}

# ---------- API: Cloud Run, reachable only through the load balancer ----------
resource "google_cloud_run_v2_service" "api" {
  name     = "arabica-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = 40
    timeout                          = "15s"
    scaling {
      min_instance_count = 0 # cold starts accepted at this volume; revisit with the measured p95 (README triggers)
      max_instance_count = 10
    }
    vpc_access {
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.private.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.api_image
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true # request-based billing
        startup_cpu_boost = true
      }
      env {
        name  = "VERTEX_MODEL"
        value = local.vertex_model
      }
      env {
        name  = "VERTEX_LOCATION"
        value = var.region
      }
      env {
        name  = "INTAKE_AI_ENABLED"
        value = "0" # the switch; ADR-012 decides when it turns on
      }
    }
  }
}

# The model call never runs inside the customer's request: the API enqueues one task after the
# reference is stored, and the queue calls the API's internal route with retries and a rate cap.
resource "google_cloud_tasks_queue" "suggestions" {
  name     = "arabica-suggestions"
  location = var.region
  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 5
  }
  retry_config {
    max_attempts       = 2 # one retry; a provider error then falls back to today's handoff
    min_backoff        = "1s"
    max_backoff        = "5s"
    max_retry_duration = "30s"
  }
}

# ---------- Edge: one global HTTPS load balancer, Cloud Armor, Cloud CDN for the site ----------
resource "google_compute_security_policy" "edge" {
  name = "arabica-edge"

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr { expression = "evaluatePreconfiguredWaf('sqli-v33-stable') || evaluatePreconfiguredWaf('xss-v33-stable')" }
    }
    description = "OWASP SQL injection and XSS signatures"
  }
  rule {
    action   = "rate_based_ban"
    priority = 2000
    match {
      expr { expression = "request.path.startsWith('/api/')" }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 120
        interval_sec = 60
      }
      ban_duration_sec = 300
    }
    description = "Per-IP rate limit on the API"
  }
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    description = "Default"
  }
}

resource "google_storage_bucket" "site" {
  name                        = "${var.project_id}-site"
  location                    = var.region
  uniform_bucket_level_access = true
  website { main_page_suffix = "index.html" }
}

resource "google_compute_backend_bucket" "site" {
  name        = "arabica-site"
  bucket_name = google_storage_bucket.site.name
  enable_cdn  = true
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "arabica-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.api.name }
}

resource "google_compute_backend_service" "api" {
  name                  = "arabica-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge.id
  backend { group = google_compute_region_network_endpoint_group.api.id }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "edge" {
  name            = "arabica-edge"
  default_service = google_compute_backend_bucket.site.id
  host_rule {
    hosts        = [var.domain]
    path_matcher = "app"
  }
  path_matcher {
    name            = "app"
    default_service = google_compute_backend_bucket.site.id
    path_rule {
      paths   = ["/api/*"]
      service = google_compute_backend_service.api.id
    }
  }
}

resource "google_compute_managed_ssl_certificate" "edge" {
  name = "arabica-edge"
  managed { domains = [var.domain] }
}

resource "google_compute_target_https_proxy" "edge" {
  name             = "arabica-edge"
  url_map          = google_compute_url_map.edge.id
  ssl_certificates = [google_compute_managed_ssl_certificate.edge.id]
}

resource "google_compute_global_address" "edge" {
  name = "arabica-edge"
}

resource "google_compute_global_forwarding_rule" "edge" {
  name                  = "arabica-edge"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.edge.id
  ip_address            = google_compute_global_address.edge.id
  port_range            = "443"
}

# ---------- Batch: daily Cloud Run job into a CMEK lake, scheduled ----------
resource "google_storage_bucket" "lake" {
  name                        = "${var.project_id}-lake"
  location                    = var.region
  uniform_bucket_level_access = true
  encryption { default_kms_key_name = google_kms_crypto_key.data.id }
  lifecycle_rule {
    condition {
      age            = 7
      matches_prefix = ["silver/", "gold/"] # rebuilt daily; Bronze is kept
    }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "batch_lake" {
  bucket = google_storage_bucket.lake.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.batch.email}"
}

resource "google_cloud_run_v2_job" "batch" {
  name     = "arabica-batch"
  location = var.region
  template {
    template {
      service_account = google_service_account.batch.email
      timeout         = "1800s"
      max_retries     = 1
      containers {
        image = var.batch_image
        resources { limits = { cpu = "2", memory = "4Gi" } }
      }
    }
  }
}

resource "google_cloud_scheduler_job" "batch" {
  name     = "arabica-batch-daily"
  region   = var.region
  schedule = "0 6 * * *"
  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.batch.name}:run"
    oauth_token { service_account_email = google_service_account.batch.email }
  }
}

# ---------- Operations: logs keep references only, 30 days ----------
resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = 30
}
