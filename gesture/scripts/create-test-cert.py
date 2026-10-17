"""为局域网摄像头测试生成独立 CA 和服务器证书；不自动修改系统信任。"""
import argparse
import ipaddress
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description='生成 Mac mini 局域网测试证书')
parser.add_argument('ip', help='Mac mini 的局域网 IP')
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent.parent / 'backend/certs')
args = parser.parse_args()
address = str(ipaddress.ip_address(args.ip))
folder = args.output.resolve()
folder.mkdir(exist_ok=True)
if any(folder.iterdir()):
    parser.error('backend/certs 已有文件，请复用证书；更换 IP 时手动移走旧证书再生成')
os.umask(0o077)
config = folder / 'server.cnf'
config.write_text(f'''[req]
distinguished_name=dn
req_extensions=ext
prompt=no
[dn]
CN=Mac mini 手势测试
[ext]
subjectAltName=IP:{address},IP:127.0.0.1,DNS:localhost
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
''')
def run(*args):
    subprocess.run(['openssl', *args], cwd=folder, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
(folder / 'ca.cnf').write_text('''[req]
distinguished_name=dn
x509_extensions=v3_ca
prompt=no
[dn]
CN=Gesture Demo Local Test CA
[v3_ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
''')
run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem',
    '-days', '30', '-sha256', '-subj', '/CN=Gesture Demo Local Test CA', '-config', 'ca.cnf', '-extensions', 'v3_ca')
run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server-key.pem', '-out', 'server.csr', '-config', 'server.cnf')
run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial',
    '-out', 'server.pem', '-days', '30', '-sha256', '-extfile', 'server.cnf', '-extensions', 'ext')
print('证书已生成。只将 backend/certs/ca.pem 复制到测试电脑并设为受信任；私钥留在 Mac mini。有效期 30 天。')
