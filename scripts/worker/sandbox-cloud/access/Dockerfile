FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-client openssh-server ca-certificates tini curl python3 && rm -rf /var/lib/apt/lists/* && rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd
COPY admin.pub /etc/ssh/authorized_admin
COPY sshd_config /etc/ssh/sshd_config
COPY gateway.sh /usr/local/bin/gateway
RUN chmod 600 /etc/ssh/authorized_admin && chmod 755 /usr/local/bin/gateway
ENTRYPOINT ["/usr/bin/tini","-g","--","/usr/local/bin/gateway"]
