/*
 * Independent Darwin kernel-identity reader used ONLY as a cross-check for the
 * TypeScript libproc bridge (`src/runtime/native-process/darwin.ts`).
 *
 * Two implementations must read the SAME facts from the kernel; this program
 * never receives any value from the tested module. It prints one JSON object
 * per pid argument (plus the kernel boot-session UUID) on stdout and exits 0
 * only when every requested pid was read successfully.
 *
 * Build (macOS): cc -O0 -o pid_identity_dump pid_identity_dump.c
 */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <libproc.h>
#include <sys/proc_info.h>

/* XNU private flavor 17 is not in the public SDK headers. macOS 27 reports 56
 * bytes; the documented historical prefix is shorter, and a short reply is an
 * error here, never a truncated identity. */
#define DUMP_PROC_PIDUNIQIDENTIFIERINFO 17

struct dump_uniqidentifierinfo {
    uint8_t  p_uuid[16];
    uint64_t p_uniqueid;
    uint64_t p_puniqueid;
    int32_t  p_reserve[6];
};

static int read_boot_uuid(char *dst, size_t cap) {
    size_t len = cap;
    if (sysctlbyname("kern.bootsessionuuid", dst, &len, NULL, 0) != 0) return -1;
    if (len < 2 || len > cap) return -1;
    dst[len < cap ? len : cap - 1] = '\0';
    return 0;
}

static int dump_pid(pid_t pid) {
    struct proc_bsdinfo bsd;
    struct dump_uniqidentifierinfo uniq;
    memset(&bsd, 0, sizeof(bsd));
    memset(&uniq, 0, sizeof(uniq));
    int bsd_bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
    if (bsd_bytes != (int)sizeof(bsd)) {
        fprintf(stderr, "pid %d: proc_pidinfo flavor 3 returned %d bytes (errno %d)\n", pid, bsd_bytes, errno);
        return -1;
    }
    int uniq_bytes = proc_pidinfo(pid, DUMP_PROC_PIDUNIQIDENTIFIERINFO, 0, &uniq, sizeof(uniq));
    if (uniq_bytes != (int)sizeof(uniq)) {
        fprintf(stderr, "pid %d: proc_pidinfo flavor 17 returned %d bytes (errno %d)\n", pid, uniq_bytes, errno);
        return -1;
    }
    int sid = getsid(pid);
    if (sid < 0) {
        fprintf(stderr, "pid %d: getsid failed (errno %d)\n", pid, errno);
        return -1;
    }
    printf("{\"pid\":%d,\"ppid\":%u,\"pgid\":%u,\"sid\":%d,\"uid\":%u,"
           "\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 ","
           "\"uniqueId\":%" PRIu64 ",\"parentUniqueId\":%" PRIu64 ",\"uuidHex\":\"",
           pid, bsd.pbi_ppid, bsd.pbi_pgid, sid, (unsigned)bsd.pbi_uid,
           bsd.pbi_start_tvsec, bsd.pbi_start_tvusec,
           uniq.p_uniqueid, uniq.p_puniqueid);
    for (int i = 0; i < 16; i++) printf("%02x", uniq.p_uuid[i]);
    printf("\"}\n");
    return 0;
}

int main(int argc, char **argv) {
    char boot_uuid[64] = {0};
    if (argc < 2) {
        fprintf(stderr, "usage: %s <pid>...\n", argv[0]);
        return 2;
    }
    if (read_boot_uuid(boot_uuid, sizeof(boot_uuid)) != 0) {
        fprintf(stderr, "kern.bootsessionuuid is unreadable\n");
        return 1;
    }
    printf("{\"bootUuid\":\"%s\"}\n", boot_uuid);
    for (int i = 1; i < argc; i++) {
        char *end = NULL;
        long pid = strtol(argv[i], &end, 10);
        if (end == argv[i] || *end != '\0' || pid <= 0) {
            fprintf(stderr, "invalid pid argument: %s\n", argv[i]);
            return 2;
        }
        if (dump_pid((pid_t)pid) != 0) return 1;
    }
    return 0;
}
