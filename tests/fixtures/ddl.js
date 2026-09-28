// A trimmed pg_dump script used by the schema tests
export const PG_DUMP = `--
-- PostgreSQL database dump
--
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated := now(); RETURN NEW; END;
$$;
CREATE TABLE public.departments (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    tags text[],
    budget numeric(12,2) DEFAULT 0.00
);
ALTER TABLE public.departments OWNER TO postgres;
CREATE TABLE public.employees (
    id integer NOT NULL,
    department_id integer,
    manager_id integer,
    email text DEFAULT ''::text NOT NULL
);
ALTER TABLE ONLY public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employees ADD CONSTRAINT employees_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employees ADD CONSTRAINT employees_email_key UNIQUE (email);
ALTER TABLE ONLY public.employees ADD CONSTRAINT emp_dept FOREIGN KEY (department_id) REFERENCES public.departments(id);
ALTER TABLE ONLY public.employees ADD CONSTRAINT emp_mgr FOREIGN KEY (manager_id) REFERENCES public.employees(id);
CREATE INDEX idx_emp ON public.employees USING btree (department_id);
`;
