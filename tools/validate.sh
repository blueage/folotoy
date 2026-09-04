#!/usr/bin/env bash
# 统一验证入口。CI 与本地跑同一个脚本。
#   --static    主机侧：固件纯逻辑测试 + 固件校验脚本自测 + 网页类型检查与单测
#   --firmware  ESP-IDF 编译、merge-bin、分区与 Recovery 兼容校验
#   （无参数）  两者都跑
set -euo pipefail

mode="${1:---all}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
    echo "Usage: $0 [--all|--static|--firmware|--web]" >&2
}

run_host_tests() {
    local test_dir
    test_dir="$(mktemp -d /tmp/folo2fa-host-tests.XXXXXX)"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_otp_core.c main/otp_core.c main/otp_wire.c main/otp_vault_codec.c \
        main/otp_icon.c \
        -o "${test_dir}/test_otp_core"
    "${test_dir}/test_otp_core"
    python3 tests/test_verify_firmware.py
    python3 tests/test_gen_sprite.py
    rm -rf "${test_dir}"
    echo "Host tests: PASS"
}

run_web_checks() {
    if [[ ! -d "${repo_root}/web/node_modules" ]]; then
        echo "web/node_modules 不存在，先运行 (cd web && npm install)" >&2
        return 1
    fi
    (cd "${repo_root}/web" && npm run typecheck && npm run lint && npm test)
    echo "Web checks: PASS"
}

run_firmware_checks() (
    local validation_build_dir

    if ! command -v idf.py >/dev/null 2>&1; then
        echo "ERROR: idf.py 不可用；先 source ESP-IDF 5.5.3 的 export.sh。" >&2
        return 1
    fi

    validation_build_dir="$(mktemp -d /tmp/folo2fa-firmware.XXXXXX)"
    trap 'case "${validation_build_dir}" in /tmp/folo2fa-firmware.*) rm -rf -- "${validation_build_dir}" ;; esac' EXIT

    SDKCONFIG_DEFAULTS="${repo_root}/sdkconfig.defaults" \
        idf.py -B "${validation_build_dir}" \
        -D "SDKCONFIG=${validation_build_dir}/sdkconfig" build
    idf.py -B "${validation_build_dir}" merge-bin \
        -o "${validation_build_dir}/FoloToy-AI-Passport-full.bin"
    python3 tools/verify_firmware.py "${validation_build_dir}"
    mkdir -p "${repo_root}/build"
    install -m 0644 \
        "${validation_build_dir}/FoloToy-AI-Passport-full.bin" \
        "${repo_root}/build/FoloToy-AI-Passport-full.bin"
    echo "Firmware build: PASS"
)

cd "${repo_root}"
case "${mode}" in
    --all)
        run_host_tests
        run_web_checks
        run_firmware_checks
        ;;
    --static)
        run_host_tests
        run_web_checks
        ;;
    --web)
        run_web_checks
        ;;
    --firmware)
        run_firmware_checks
        ;;
    *)
        usage
        exit 2
        ;;
esac
