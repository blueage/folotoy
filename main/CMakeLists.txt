idf_component_register(
    SRCS "main.c"
         "otp_core.c"
         "otp_wire.c"
         "otp_vault_codec.c"
         "otp_vault.c"
         "otp_clock.c"
         "otp_totp.c"
         "otp_sync.c"
         "otp_wifi.c"
         "otp_ui.c"
         "ui_pixel.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_event esp_hw_support esp_netif esp_timer esp_wifi lwip mbedtls nvs_flash
)
