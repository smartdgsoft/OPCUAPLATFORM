FROM python:3.11-slim
WORKDIR /app

# Install Microsoft ODBC Driver 18 for SQL Server (for mssql+pyodbc) + build deps.
# Write the apt source line directly (avoids the malformed-entry issue from
# patching Microsoft's prod.list). Debian 12 (bookworm) base.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl gnupg2 apt-transport-https ca-certificates unixodbc-dev gcc g++; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /etc/apt/keyrings/microsoft-prod.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
        > /etc/apt/sources.list.d/mssql-release.list; \
    apt-get update; \
    ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "-m", "main"]
